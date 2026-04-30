'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch, oauthErrorMessage, tryRecoverFromUnauthorized } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { openGmailOAuthWindow, subscribeGmailOAuthComplete } from '@/lib/gmail-oauth';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';

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

type TeamConversation = {
  conversation_id: string;
  employee_id: string;
  client_name: string | null;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  summary: string;
  short_reason: string;
  updated_at: string;
  open_gmail_link?: string;
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
  const [conversations, setConversations] = useState<TeamConversation[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
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

  const selectedMailbox = useMemo(
    () => teamMailboxes.find((mb) => mb.id === selectedMailboxId) ?? teamMailboxes[0] ?? null,
    [teamMailboxes, selectedMailboxId],
  );

  const selectedConversations = useMemo(() => {
    if (!selectedMailbox) return [];
    return conversations
      .filter((c) => c.employee_id === selectedMailbox.id)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }, [conversations, selectedMailbox]);

  const selectedAlerts = useMemo(
    () =>
      selectedConversations.filter((c) =>
        ['PENDING', 'MISSED'].includes(String(c.follow_up_status ?? '').toUpperCase()),
      ),
    [selectedConversations],
  );

  const alertCountByEmployee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conversations) {
      if (!['PENDING', 'MISSED'].includes(String(c.follow_up_status ?? '').toUpperCase())) continue;
      counts.set(c.employee_id, (counts.get(c.employee_id) ?? 0) + 1);
    }
    return counts;
  }, [conversations]);

  const selectedStats = useMemo(() => {
    const stats = { pending: 0, missed: 0, done: 0, all: selectedConversations.length };
    for (const c of selectedConversations) {
      const s = String(c.follow_up_status ?? '').toUpperCase();
      if (s === 'MISSED') stats.missed += 1;
      else if (s === 'DONE') stats.done += 1;
      else if (s === 'PENDING') stats.pending += 1;
    }
    return stats;
  }, [selectedConversations]);

  useEffect(() => {
    if (teamMailboxes.length === 0) {
      setSelectedMailboxId('');
      return;
    }
    setSelectedMailboxId((prev) =>
      prev && teamMailboxes.some((mb) => mb.id === prev) ? prev : teamMailboxes[0].id,
    );
  }, [teamMailboxes]);

  const loadTeamData = useCallback(async (t: string) => {
    const [empRes, dashRes] = await Promise.all([
      apiFetch('/employees', t),
      apiFetch('/dashboard', t),
    ]);
    if (!empRes.ok) {
      if (await tryRecoverFromUnauthorized(empRes, ctxSignOut)) return;
      const j = await empRes.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Could not load team mailboxes');
      setRows([]);
      setConversations([]);
      return;
    }
    setRows((await empRes.json()) as TeamMailbox[]);
    if (dashRes.ok) {
      const body = (await dashRes.json().catch(() => ({}))) as { conversations?: TeamConversation[] };
      setConversations(body.conversations ?? []);
    } else {
      setConversations([]);
    }
    setError(null);
  }, [ctxSignOut]);

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
      await loadTeamData(token);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, me, token, router, loadTeamData]);

  useEffect(() => {
    if (authLoading || !token || !me || !isDepartmentManagerRole(me.role)) return;
    const id = window.setTimeout(() => void loadTeamData(token), 180);
    return () => clearTimeout(id);
  }, [authLoading, token, me, loadTeamData]);

  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;
    if (oauthErr) setError(oauthErrorMessage(oauthErr));
    if (connected === '1') {
      setSuccess('Gmail connected successfully.');
      void loadTeamData(token);
    }
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id']) params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [authLoading, token, searchParams, pathname, router, loadTeamData]);

  useEffect(() => {
    if (!token) return;
    return subscribeGmailOAuthComplete(({ next, connected, employee_id }) => {
      if (connected) setSuccess('Gmail connected successfully.');
      void loadTeamData(token);
      const q = new URLSearchParams();
      if (connected) q.set('connected', '1');
      if (employee_id) q.set('employee_id', employee_id);
      const qs = q.toString();
      router.replace(qs ? `${next}?${qs}` : next);
    });
  }, [token, loadTeamData, router]);

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
      if (!res.ok) {
        if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
      }
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
      <AppShell role="HEAD" title="Team mail sync" subtitle="" onSignOut={() => void ctxSignOut()}>
        <PortalPageLoader variant="embedded" />
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
        <PortalPageLoader variant="embedded" dense />
      ) : (
        <section className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-6">
          <h2 className="text-lg font-bold text-slate-900">Team mail workspace</h2>
          <p className="mt-1 text-sm text-slate-600">
            Select a team member to check their mailbox connection, follow-up alerts, and recent thread notifications.
            Manage roster in{' '}
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
            <>
            <div className="mt-6 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                <p className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Team mail</p>
                <div className="mt-2 space-y-2">
                  {teamMailboxes.map((mb) => {
                    const active = selectedMailbox?.id === mb.id;
                    return (
                      <button
                        key={mb.id}
                        type="button"
                        onClick={() => setSelectedMailboxId(mb.id)}
                        className={`w-full rounded-xl px-3 py-2 text-left transition ${
                          active
                            ? 'bg-white shadow-sm ring-1 ring-brand-200'
                            : 'hover:bg-white/80'
                        }`}
                      >
                        <span className="block truncate text-sm font-semibold text-slate-900">{mb.name}</span>
                        <span className="block truncate text-xs text-slate-500">{mb.email}</span>
                        {(alertCountByEmployee.get(mb.id) ?? 0) > 0 ? (
                          <span className="mt-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                            {alertCountByEmployee.get(mb.id)} alert{alertCountByEmployee.get(mb.id) === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                {selectedMailbox ? (
                  <>
                    <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Selected employee</p>
                        <h3 className="mt-1 truncate text-xl font-bold text-slate-900">{selectedMailbox.name}</h3>
                        <p className="mt-1 truncate text-sm text-slate-500">{selectedMailbox.email}</p>
                        <p className="mt-1 text-xs text-slate-500">{selectedMailbox.department_name?.trim() || 'No department'}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Link
                          href={`/employees/${encodeURIComponent(selectedMailbox.id)}/mails`}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                        >
                          Open threads
                        </Link>
                        <button
                          type="button"
                          disabled={connectingId === selectedMailbox.id}
                          onClick={() => void connectGmail(selectedMailbox.id)}
                          className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-60"
                        >
                          {connectingId === selectedMailbox.id ? 'Opening…' : selectedMailbox.gmail_connected ? 'Reconnect Gmail' : 'Connect Gmail'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      <div className="rounded-xl bg-slate-50 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Gmail</p>
                        <p className={`mt-1 text-sm font-bold ${gmailLabel(selectedMailbox).className}`}>
                          {gmailLabel(selectedMailbox).text}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Need reply</p>
                        <p className="mt-1 text-xl font-bold tabular-nums text-amber-700">{selectedStats.pending}</p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Missed SLA</p>
                        <p className="mt-1 text-xl font-bold tabular-nums text-red-600">{selectedStats.missed}</p>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-3 py-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">All threads</p>
                        <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">{selectedStats.all}</p>
                      </div>
                    </div>

                    <div className="mt-5">
                      <h4 className="text-sm font-bold text-slate-900">Alerts and notifications</h4>
                      {selectedAlerts.length === 0 ? (
                        <p className="mt-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-4 text-sm text-slate-500">
                          No active follow-up alerts for this employee.
                        </p>
                      ) : (
                        <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
                          {selectedAlerts.slice(0, 5).map((c) => (
                            <div key={c.conversation_id} className="px-4 py-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-semibold text-slate-900">
                                  {c.client_name || c.client_email || 'Unknown client'}
                                </p>
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  String(c.follow_up_status).toUpperCase() === 'MISSED'
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-800'
                                }`}>
                                  {String(c.follow_up_status).replaceAll('_', ' ')}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-sm text-slate-600">
                                {c.short_reason || c.summary || 'Follow-up needed.'}
                              </p>
                              <p className="mt-1 text-xs text-slate-400">Updated {relativeTime(c.updated_at)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </div>

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
            </>
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
        <PortalPageLoader variant="fullscreen" />
      }
    >
      <TeamMailSyncInner />
    </Suspense>
  );
}
