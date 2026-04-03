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
  /** Re-fetch /auth/me (rarely needed) */
  refreshMe: () => Promise<void>;
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

      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) {
        if (meRes.status === 401) {
          await supabase.auth.signOut();
          setLoading(false);
          return;
        }
        setError('Could not load profile.');
        setLoading(false);
        return;
      }

      setMe((await meRes.json()) as AuthMe);
    } catch {
      setError('Authentication error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setMe(null);
        setToken(null);
      } else if (session.access_token !== token) {
        setToken(session.access_token);
      }
    });
    return () => subscription.unsubscribe();
  }, [token]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setMe(null);
    setToken(null);
    router.replace('/auth');
  }, [router]);

  const refreshMe = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/auth/me', token);
    if (res.ok) setMe((await res.json()) as AuthMe);
  }, [token]);

  const value = useMemo(
    () => ({ me, token, loading, error, signOut, refreshMe }),
    [me, token, loading, error, signOut, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
