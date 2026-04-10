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
import { apiFetch } from '@/lib/api';

export type AuthMe = {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  company_name?: string | null;
  role: string;
  department_id: string | null;
};

type AuthState = {
  me: AuthMe | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
  /** Re-fetch /auth/me; pass token immediately after sign-in so navigation waits on profile. */
  refreshMe: (accessToken?: string) => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  me: null,
  token: null,
  loading: true,
  error: null,
  signOut: async () => {},
  refreshMe: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<AuthMe | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async (accessToken: string) => {
    let meRes: Response;
    try {
      meRes = await apiFetch('/auth/me', accessToken);
    } catch {
      setError('Cannot reach API server. Check backend URL or whether backend is running.');
      setMe(null);
      return;
    }
    if (!meRes.ok) {
      if (meRes.status === 401) {
        const supabase = createClient();
        await supabase.auth.signOut();
        setMe(null);
        setToken(null);
        setError(null);
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
          return;
        }
      }
      setError('Could not load profile.');
      setMe(null);
      return;
    }
    setMe((await meRes.json()) as AuthMe);
    setError(null);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setLoading(false);
        return;
      }

      setToken(session.access_token);
      await loadProfile(session.access_token);
    } catch {
      setError('Authentication error.');
    } finally {
      setLoading(false);
    }
  }, [loadProfile]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /**
   * Subscribe once (do not depend on `token` — that re-subscribed every refresh and caused request storms).
   * After sign-in, load `/auth/me` here; bootstrap alone only runs once on mount and would leave `me` null.
   */
  useEffect(() => {
    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session) {
        setMe(null);
        setToken(null);
        setError(null);
        return;
      }
      setToken(session.access_token);
      if (event === 'INITIAL_SESSION') {
        return;
      }
      await loadProfile(session.access_token);
    });
    return () => subscription.unsubscribe();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setMe(null);
    setToken(null);
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
    () => ({ me, token, loading, error, signOut, refreshMe }),
    [me, token, loading, error, signOut, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
