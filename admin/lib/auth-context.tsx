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
import { apiFetch } from '@/lib/api';

export type AuthMe = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
};

type AuthState = {
  me: AuthMe | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  me: null,
  token: null,
  loading: true,
  error: null,
  signOut: async () => {},
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
    try {
      const meRes = await apiFetch('/auth/me', accessToken);
      if (!meRes.ok) {
        if (meRes.status === 401) {
          const supabase = createClient();
          await supabase.auth.signOut();
          setMe(null);
          setToken(null);
          return;
        }
        setError('Could not load profile.');
        setMe(null);
        return;
      }
      const parsed = (await meRes.json()) as AuthMe;
      setMe(parsed);
      setError(null);
    } catch {
      setError('Cannot reach API server. Check NEXT_PUBLIC_API_URL.');
      setMe(null);
    }
  }, []);

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
            setLoading(false);
            return;
          }
          setToken(session.access_token);
          if (event === 'TOKEN_REFRESHED') return;
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

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setMe(null);
    setToken(null);
    router.replace('/login');
  }, [router]);

  const value = useMemo(
    () => ({ me, token, loading, error, signOut }),
    [me, token, loading, error, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
