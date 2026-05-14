'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatAuthClientError } from '@/lib/supabase/public-env';
import { apiFetch, MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY } from '@/lib/api';

export type ManagedDepartment = { id: string; name: string };

export type AuthMe = {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  company_name?: string | null;
  role: string;
  department_id: string | null;
  managed_department_ids?: string[];
  managed_departments?: ManagedDepartment[];
  /** `employees.id` when this login is linked to a mailbox row (managers & employee portal). */
  linked_employee_id?: string | null;
};

function resolveManagerActiveDept(me: AuthMe): string | null {
  if (me.role !== 'HEAD' || !me.managed_department_ids?.length) return null;
  const allowed = new Set(me.managed_department_ids);
  let fromStore = '';
  try {
    if (typeof window !== 'undefined') {
      fromStore = localStorage.getItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY)?.trim() ?? '';
    }
  } catch {
    /* ignore */
  }
  if (fromStore && allowed.has(fromStore)) return fromStore;
  const fb =
    me.department_id && allowed.has(me.department_id)
      ? me.department_id
      : (me.managed_department_ids[0] ?? null);
  if (fb && typeof window !== 'undefined') {
    try {
      localStorage.setItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY, fb);
    } catch {
      /* ignore */
    }
  }
  return fb;
}

type AuthState = {
  me: AuthMe | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
  /** Re-fetch /auth/me; pass token immediately after sign-in so navigation waits on profile. */
  refreshMe: (accessToken?: string) => Promise<void>;
  /** Department manager (HEAD): active team for API scope (`x-manager-department-id`). */
  managerActiveDepartmentId: string | null;
  setManagerActiveDepartmentId: (id: string) => void;
  /**
   * Last resolved app role (persisted in sessionStorage) so AppShell can avoid flashing CEO-only nav
   * while `/auth/me` is still loading after refresh or OAuth.
   */
  shellRoleHint: string | null;
};

const AuthContext = createContext<AuthState>({
  me: null,
  token: null,
  loading: true,
  error: null,
  signOut: async () => {},
  refreshMe: async () => {},
  managerActiveDepartmentId: null,
  setManagerActiveDepartmentId: () => {},
  shellRoleHint: null,
});

const SHELL_ROLE_STORAGE_KEY = 'ai_et_shell_role_v1';

function readShellRoleFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = sessionStorage.getItem(SHELL_ROLE_STORAGE_KEY)?.trim();
    return v || null;
  } catch {
    return null;
  }
}

function writeShellRoleToStorage(role: string) {
  try {
    sessionStorage.setItem(SHELL_ROLE_STORAGE_KEY, role);
  } catch {
    /* ignore */
  }
}

function clearShellRoleStorage() {
  try {
    sessionStorage.removeItem(SHELL_ROLE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<AuthMe | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managerActiveDepartmentId, setManagerActiveDepartmentIdState] = useState<string | null>(null);
  const [shellRoleHint, setShellRoleHint] = useState<string | null>(null);

  useEffect(() => {
    const r = readShellRoleFromStorage();
    if (r) setShellRoleHint(r);
  }, []);

  const loadProfile = useCallback(async (accessToken: string) => {
    let meRes: Response;
    try {
      meRes = await apiFetch('/auth/me', accessToken);
    } catch {
      setError('Cannot reach API server. Check backend URL or whether backend is running.');
      setMe(null);
      setManagerActiveDepartmentIdState(null);
      setShellRoleHint(null);
      return;
    }
    if (!meRes.ok) {
      if (meRes.status === 401) {
        const supabase = createClient();
        await supabase.auth.signOut();
        setMe(null);
        setToken(null);
        setLoading(false);
        setError(null);
        setManagerActiveDepartmentIdState(null);
        setShellRoleHint(null);
        clearShellRoleStorage();
        return;
      }
      // Signed in to Supabase but no `users` row yet — backend returns 403 ONBOARDING_REQUIRED (see AppAuthGuard).
      if (meRes.status === 403) {
        let body: unknown;
        try {
          body = await meRes.json();
        } catch {
          body = null;
        }
        const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
        const nested =
          o?.message && typeof o.message === 'object' && o.message !== null
            ? (o.message as Record<string, unknown>)
            : null;
        const code = (typeof o?.code === 'string' ? o.code : nested?.code) as string | undefined;
        if (code === 'ONBOARDING_REQUIRED') {
          setMe(null);
          setError(null);
          setManagerActiveDepartmentIdState(null);
          setShellRoleHint(null);
          clearShellRoleStorage();
          return;
        }
      }
      setError('Could not load profile.');
      setMe(null);
      setManagerActiveDepartmentIdState(null);
      setShellRoleHint(null);
      return;
    }
    const parsed = (await meRes.json()) as AuthMe;
    setMe(parsed);
    setManagerActiveDepartmentIdState(resolveManagerActiveDept(parsed));
    setShellRoleHint(parsed.role);
    writeShellRoleToStorage(parsed.role);
    setError(null);
  }, []);

  const setManagerActiveDepartmentId = useCallback((id: string) => {
    try {
      localStorage.setItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
    setManagerActiveDepartmentIdState(id);
  }, []);

  /**
   * Single auth pipeline: do not also call `getSession()` on mount — that races
   * `onAuthStateChange(INITIAL_SESSION)` and duplicates token refresh (504 + lock warnings).
   */
  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;
    try {
      const supabase = createClient();
      ({
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, session) => {
        void (async () => {
          if (cancelled) return;
          if (!session) {
            setMe(null);
            setToken(null);
            setError(null);
            setManagerActiveDepartmentIdState(null);
            setShellRoleHint(null);
            clearShellRoleStorage();
            try {
              localStorage.removeItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY);
            } catch {
              /* ignore */
            }
            setLoading(false);
            return;
          }

          setToken(session.access_token);

          if (event === 'TOKEN_REFRESHED') {
            return;
          }

          try {
            await loadProfile(session.access_token);
          } catch (err) {
            if (!cancelled) setError(formatAuthClientError(err));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
      }));
    } catch (err) {
      setError(formatAuthClientError(err));
      setLoading(false);
      return () => {
        cancelled = true;
        subscription?.unsubscribe();
      };
    }
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [loadProfile]);

  /** If Supabase hangs (e.g. stuck token refresh), avoid an infinite shell spinner. */
  useEffect(() => {
    if (!loading) return;
    const id = window.setTimeout(() => {
      setLoading((still) => {
        if (!still) return still;
        setError(
          'Sign-in check is taking too long (often a slow or failing Supabase request). Try refreshing, or wait and try again.',
        );
        return false;
      });
    }, 22000);
    return () => window.clearTimeout(id);
  }, [loading]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setMe(null);
    setToken(null);
    setManagerActiveDepartmentIdState(null);
    setShellRoleHint(null);
    clearShellRoleStorage();
    try {
      localStorage.removeItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    router.replace('/auth');
  }, [router]);

  /** Pass `accessToken` right after sign-in so profile loads before navigation (token state may lag). */
  const refreshMe = useCallback(
    async (accessToken?: string) => {
      const t = accessToken ?? token;
      if (!t) return;
      await loadProfile(t);
    },
    [token, loadProfile],
  );

  const value = useMemo(
    () => ({
      me,
      token,
      loading,
      error,
      signOut,
      refreshMe,
      managerActiveDepartmentId,
      setManagerActiveDepartmentId,
      shellRoleHint,
    }),
    [
      me,
      token,
      loading,
      error,
      signOut,
      refreshMe,
      managerActiveDepartmentId,
      setManagerActiveDepartmentId,
      shellRoleHint,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
