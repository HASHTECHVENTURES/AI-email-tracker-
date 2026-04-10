'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch, oauthErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { openGmailOAuthWindow, subscribeGmailOAuthComplete } from '@/lib/gmail-oauth';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

type TeamMailbox = {
  id: string;
  name: string;
  email: string;
  department_name?: string;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  tracking_paused?: boolean;
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

function gmailLabel(mb: TeamMailbox): { text: string; className: string } {
  if (mb.gmail_connected) return { text: 'Connected', className: 'text-emerald-700' };
  const s = mb.gmail_status;
  if (s === 'REVOKED') return { text: 'Revoked', className: 'text-red-700' };
  if (s === 'EXPIRED') return { text: 'Expired', className: 'text-amber-700' };
  return { text: 'Not connected', className: 'text-slate-500' };
}

function TeamMailSyncInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [rows, setRows] = useState<TeamMailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const headEmailNorm = me?.email?.trim().toLowerCase() ?? '';

  const teamMailboxes = useMemo(
    () =>
      rows
        .filter((mb) => headEmailNorm !== '' && mb.email.trim().toLowerCase() !== headEmailNorm)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows, headEmailNorm],
  );

  const loadEmployees = useCallback(async (t: string) => {
    const res = await apiFetch('/employees', t);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Could not load team mailboxes');
      setRows([]);
      return;
    }
    setRows((await res.json()) as TeamMailbox[]);
    setError(null);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      router.replace('/auth');
      return;
    }
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (!isDepartmentManagerRole(me.role)) {
      router.replace('/dashboard');
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadEmployees(token);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, me, token, router, loadEmployees]);

  useEffect(() => {
    if (authLoading || !token || !me || !isDepartmentManagerRole(me.role)) return;
    const id = window.setTimeout(() => void loadEmployees(token), 180);
    return () => clearTimeout(id);
  }, [authLoading, token, me, loadEmployees]);

  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;
    if (oauthErr) setError(oauthErrorMessage(oauthErr));
    if (connected === '1') {
      setSuccess('Gmail connected successfully.');
      void loadEmployees(token);
    }
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id']) params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [authLoading, token, searchParams, pathname, router, loadEmployees]);

  useEffect(() => {
    if (!token) return;
    return subscribeGmailOAuthComplete(({ next, connected, employee_id }) => {
      if (connected) setSuccess('Gmail connected successfully.');
      void loadEmployees(token);
      const q = new URLSearchParams();
      if (connected) q.set('connected', '1');
      if (employee_id) q.set('employee_id', employee_id);
      const qs = q.toString();
      router.replace(qs ? `${next}?${qs}` : next);
    });
  }, [token, loadEmployees, router]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  async function connectGmail(mailboxId: string) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    setConnectingId(mailboxId);
    setError(null);
    try {
      const res = await apiFetch(
        `/auth/gmail/authorize-url?employee_id=${encodeURIComponent(mailboxId)}`,
        session.access_token,
      );
      const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!res.ok || !body.url) {
        setError(body.message || 'Could not start Google connection');
        return;
      }
      openGmailOAuthWindow(body.url);
    } finally {
      setConnectingId(null);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell role="HEAD" title="Team mail sync" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }

  if (!isDepartmentManagerRole(me.role)) {
    return null;
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name}
      userDisplayName={me.full_name || me.email}
      title="Team mail sync"
      subtitle="Gmail connection and last sync for each team member’s mailbox — separate from your own My Email inbox."
      onSignOut={() => void ctxSignOut()}
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-2 font-semibold underline">
            Dismiss
          </button>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
        </div>
      )}

      {loading ? (
        <PageSkeleton />
      ) : (
        <section className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-6">
          <h2 className="text-lg font-bold text-slate-900">Employee mailboxes</h2>
          <p className="mt-1 text-sm text-slate-600">
            Team members listed here exclude your own login. Manage roster in{' '}
            <Link href="/employees" className="font-semibold text-brand-600 hover:underline">
              Team
            </Link>
            .
          </p>

          {teamMailboxes.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center text-sm text-slate-600">
              No other team mailboxes in your scope yet. Add people under{' '}
              <Link href="/employees" className="font-semibold text-brand-600 hover:underline">
                Team
              </Link>
              .
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-3">Name</th>
                    <th className="px-3 py-3">Email</th>
                    <th className="px-3 py-3">Department</th>
                    <th className="px-3 py-3">Gmail</th>
                    <th className="px-3 py-3">Last sync</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {teamMailboxes.map((mb) => {
                    const g = gmailLabel(mb);
                    return (
                      <tr key={mb.id} className="hover:bg-slate-50/80">
                        <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-900">{mb.name}</td>
                        <td className="max-w-[12rem] truncate px-3 py-3 text-slate-600" title={mb.email}>
                          {mb.email}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          {mb.department_name?.trim() || '—'}
                        </td>
                        <td className={`whitespace-nowrap px-3 py-3 font-medium ${g.className}`}>{g.text}</td>
                        <td
                          className="whitespace-nowrap px-3 py-3 text-slate-600"
                          title={mb.last_synced_at ? new Date(mb.last_synced_at).toLocaleString() : undefined}
                        >
                          {relativeTime(mb.last_synced_at)}
                          {mb.tracking_paused ? (
                            <span className="ml-1 text-xs text-amber-700">(paused)</span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Link
                              href={`/employees/${encodeURIComponent(mb.id)}/mails`}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                            >
                              Threads
                            </Link>
                            <button
                              type="button"
                              disabled={connectingId === mb.id}
                              onClick={() => void connectGmail(mb.id)}
                              className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-60"
                            >
                              {connectingId === mb.id ? '…' : mb.gmail_connected ? 'Reconnect' : 'Connect'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}

export default function TeamMailSyncPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <PageSkeleton />
        </div>
      }
    >
      <TeamMailSyncInner />
    </Suspense>
  );
}
