'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { useSupabaseRealtimeRefresh } from '@/lib/use-supabase-realtime-refresh';
import type { CompanyRow, PlatformStats } from './types';

export function usePlatformAdmin(loginNext = '/admin') {
  const router = useRouter();
  const { token, authLoading, me, signOut } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const meRes = await apiFetch('/platform-admin/me', token);
    if (!meRes.ok) {
      setAllowed(false);
      setLoading(false);
      return;
    }
    const meBody = (await meRes.json()) as { allowed?: boolean };
    if (!meBody.allowed) {
      setAllowed(false);
      setLoading(false);
      return;
    }
    setAllowed(true);
    const [sRes, cRes] = await Promise.all([
      apiFetch('/platform-admin/stats', token),
      apiFetch('/platform-admin/companies', token),
    ]);
    if (sRes.ok) setStats((await sRes.json()) as PlatformStats);
    if (cRes.ok) {
      setCompanies(((await cRes.json()) as CompanyRow[]) ?? []);
      setError(null);
    } else {
      setError(await readApiErrorMessage(cRes, 'Could not load companies.'));
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      router.replace(`/admin/login?next=${encodeURIComponent(loginNext)}`);
      return;
    }
    setLoading(true);
    void load();
  }, [authLoading, token, router, load, loginNext]);

  useRefetchOnFocus(() => void load(), Boolean(token && !authLoading && allowed === true));

  useSupabaseRealtimeRefresh({
    enabled: Boolean(token && !authLoading && allowed === true),
    channelSuffix: 'platform-admin-companies',
    tables: [{ table: 'companies' }],
    onSignal: () => void load(),
    debounceMs: 450,
  });

  return {
    token,
    authLoading,
    me,
    signOut,
    allowed,
    stats,
    companies,
    setCompanies,
    loading,
    error,
    setError,
    reload: load,
  };
}
