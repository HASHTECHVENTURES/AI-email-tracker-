'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch, oauthErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { openGmailOAuthWindow, subscribeGmailOAuthComplete } from '@/lib/gmail-oauth';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import { TrackedMailboxCard } from '@/components/my-email/TrackedMailboxCard';

type Mailbox = {
  id: string;
  name: string;
  email: string;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
  ai_enabled?: boolean;
};

const DEFAULT_MAILBOX_SLA_HOURS = 24;

function effectiveMailboxSlaHours(mb: Mailbox): number {
  const v = mb.sla_hours_default;
  if (v != null && v > 0) return v;
  return DEFAULT_MAILBOX_SLA_HOURS;
}

type ConversationRow = {
  conversation_id: string;
  employee_id: string;
  employee_name: string;
  provider_thread_id: string;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  sla_hours: number;
  summary: string;
  short_reason: string;
  reason: string;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  lifecycle_status: string;
  open_gmail_link: string;
  updated_at: string;
};

type DashPayload = {
  needs_attention: ConversationRow[];
  conversations: ConversationRow[];
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    MISSED: 'bg-red-100 text-red-800',
    PENDING: 'bg-amber-100 text-amber-800',
    DONE: 'bg-emerald-100 text-emerald-800',
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? 'bg-slate-100 text-slate-700'}`}
    >
      {status}
    </span>
  );
}

function priorityDot(p: string) {
  const cls =
    p === 'HIGH'
      ? 'bg-red-500'
      : p === 'MEDIUM'
        ? 'bg-amber-400'
        : 'bg-slate-300';
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} title={p} />;
}

function ManagerMyMailInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();

  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [dash, setDash] = useState<DashPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [slaDraftById, setSlaDraftById] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [slaSavingId, setSlaSavingId] = useState<string | null>(null);
  const [togglePauseLoadingId, setTogglePauseLoadingId] = useState<string | null>(null);
  const [addingMyMailbox, setAddingMyMailbox] = useState(false);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterPriority, setFilterPriority] = useState('');

  const filterRef = useRef({
    status: filterStatus,
    priority: filterPriority,
    mailbox: '',
  });
  filterRef.current = {
    status: filterStatus,
    priority: filterPriority,
    mailbox: '',
  };

  const loadAll = useCallback(async (t: string) => {
    const f = filterRef.current;
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.priority) qs.set('priority', f.priority);
    if (f.mailbox) qs.set('employee_id', f.mailbox);
    const q = qs.toString();

    const [dashRes, empRes] = await Promise.all([
      apiFetch(`/dashboard${q ? `?${q}` : ''}`, t),
      apiFetch('/employees', t),
    ]);

    if (!empRes.ok) {
      const j = await empRes.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Failed to load team mailboxes');
      setMailboxes([]);
    } else {
      const empBody = (await empRes.json()) as Mailbox[];
      setMailboxes(empBody);
      setError(null);
    }

    if (!dashRes.ok) {
      const j = await dashRes.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Failed to load conversations');
      setDash(null);
      return;
    }

    const body = (await dashRes.json()) as {
      needs_attention: ConversationRow[];
      conversations: ConversationRow[];
    };
    const conv = body.conversations ?? [];
    setDash({
      needs_attention: body.needs_attention ?? [],
      conversations: conv,
    });
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
      await loadAll(token);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    me,
    token,
    router,
    loadAll,
  ]);

  useEffect(() => {
    if (authLoading || !token || !me) return;
    if (!isDepartmentManagerRole(me.role)) return;
    const id = window.setTimeout(() => void loadAll(token), 180);
    return () => clearTimeout(id);
  }, [authLoading, token, me, loadAll, filterStatus, filterPriority]);

  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;
    if (oauthErr) setError(oauthErrorMessage(oauthErr));
    if (connected === '1') {
      setSuccess('Gmail connected successfully.');
      void loadAll(token);
    }
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id']) params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [authLoading, token, searchParams, pathname, router, loadAll]);

  useEffect(() => {
    if (!token) return;
    return subscribeGmailOAuthComplete(({ next, connected, employee_id }) => {
      if (connected) {
        setSuccess('Gmail connected successfully.');
      }
      void loadAll(token);
      const q = new URLSearchParams();
      if (connected) q.set('connected', '1');
      if (employee_id) q.set('employee_id', employee_id);
      const qs = q.toString();
      router.replace(qs ? `${next}?${qs}` : next);
    });
  }, [token, loadAll, router]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  const headEmailNorm = me?.email?.trim().toLowerCase() ?? '';

  const ownMailboxes = useMemo(
    () =>
      mailboxes.filter(
        (mb) =>
          headEmailNorm !== '' &&
          mb.email.trim().toLowerCase() === headEmailNorm,
      ),
    [mailboxes, headEmailNorm],
  );

  async function connectGmail(mailboxId: string) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch(
      `/auth/gmail/authorize-url?employee_id=${encodeURIComponent(mailboxId)}`,
      session.access_token,
    );
    const body = (await res.json().catch(() => ({}))) as {
      url?: string;
      message?: string;
    };
    if (!res.ok || !body.url) {
      setError(body.message || 'Could not start Google connection');
      return;
    }
    openGmailOAuthWindow(body.url);
  }

  async function connectMyMailbox() {
    if (!token) return;
    setAddingMyMailbox(true);
    setError(null);
    try {
      const res = await apiFetch('/employees/my-mailbox', token, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        employee?: { id?: string };
        message?: string;
      };
      if (!res.ok) {
        setError(body.message ?? 'Could not prepare your mailbox');
        return;
      }
      const id = body.id ?? body.employee?.id;
      if (!id) {
        setError('Could not resolve your mailbox');
        return;
      }
      setSuccess('Opening Google to connect your mailbox…');
      await connectGmail(id);
    } finally {
      setAddingMyMailbox(false);
    }
  }

  function mailboxSlaInputValue(mb: Mailbox): string {
    if (slaDraftById[mb.id] !== undefined) return slaDraftById[mb.id];
    return String(
      mb.sla_hours_default != null && mb.sla_hours_default > 0
        ? mb.sla_hours_default
        : effectiveMailboxSlaHours(mb),
    );
  }

  async function saveMailboxSla(mb: Mailbox) {
    if (!token) return;
    setError(null);
    const raw = mailboxSlaInputValue(mb).trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > 168) {
      setError('Response-time target must be between 1 and 168 hours.');
      return;
    }
    setSlaSavingId(mb.id);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/sla`,
        token,
        { method: 'PATCH', body: JSON.stringify({ sla_hours: value }) },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not save SLA');
        return;
      }
      setSlaDraftById((prev) => {
        const next = { ...prev };
        delete next[mb.id];
        return next;
      });
      setSuccess(`Saved ${value}h response-time target.`);
      await loadAll(token);
    } finally {
      setSlaSavingId(null);
    }
  }

  async function toggleTrackingPause(mb: Mailbox, pause: boolean) {
    if (!token) return;
    setTogglePauseLoadingId(mb.id);
    setError(null);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/tracking-pause`,
        token,
        { method: 'PATCH', body: JSON.stringify({ paused: pause }) },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not update tracking status');
        return;
      }
      setSuccess(pause ? 'Tracking paused.' : 'Tracking enabled — live monitoring is ON.');
      await loadAll(token);
    } finally {
      setTogglePauseLoadingId(null);
    }
  }

  async function removeMailbox(mb: Mailbox) {
    if (!token) return;
    if (
      !window.confirm(
        `Remove mailbox "${mb.name}" and related data? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(mb.id);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}`,
        token,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not remove this mailbox');
        return;
      }
      setSuccess('Mailbox removed.');
      await loadAll(token);
    } finally {
      setDeletingId(null);
    }
  }

  const needsAttention = dash?.needs_attention ?? [];
  const conversations = dash?.conversations ?? [];
  const ownMailboxIds = useMemo(() => new Set(ownMailboxes.map((m) => m.id)), [ownMailboxes]);
  const scopedNeedsAttention = useMemo(
    () => needsAttention.filter((c) => ownMailboxIds.has(c.employee_id)),
    [needsAttention, ownMailboxIds],
  );
  const scopedConversations = useMemo(
    () => conversations.filter((c) => ownMailboxIds.has(c.employee_id)),
    [conversations, ownMailboxIds],
  );
  const scopedStats = useMemo(
    () => ({
      total: scopedConversations.length,
      pending: scopedConversations.filter((c) => c.follow_up_status === 'PENDING').length,
      missed: scopedConversations.filter((c) => c.follow_up_status === 'MISSED').length,
      done: scopedConversations.filter((c) => c.follow_up_status === 'DONE').length,
    }),
    [scopedConversations],
  );

  if (!me || authLoading) {
    return (
      <AppShell
        role="HEAD"
        title="My mail"
        subtitle="Loading..."
        onSignOut={() => void ctxSignOut()}
      >
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
      title="My mail"
      subtitle="Your inbox."
      onSignOut={() => void ctxSignOut()}
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
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
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Needs attention', value: scopedNeedsAttention.length, color: 'text-red-600' },
              { label: 'Pending', value: scopedStats.pending, color: 'text-amber-600' },
              { label: 'Missed SLA', value: scopedStats.missed, color: 'text-red-600' },
              { label: 'Resolved', value: scopedStats.done, color: 'text-emerald-600' },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {kpi.label}
                </p>
                <p className={`mt-1 text-2xl font-bold ${kpi.color}`}>{kpi.value}</p>
              </div>
            ))}
          </div>

          <section className="mt-8">
            <h2 className="text-lg font-bold text-slate-900">My mailbox</h2>
            <div className="mt-4">
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ownMailboxes.map((mb) => (
                  <TrackedMailboxCard
                    key={mb.id}
                    mb={mb}
                    ceoEmailNorm={headEmailNorm}
                    onConnectGmail={() => void connectGmail(mb.id)}
                    onRemove={() => void removeMailbox(mb)}
                    onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                    removing={deletingId === mb.id}
                    togglePauseLoading={togglePauseLoadingId === mb.id}
                  />
                ))}
              </div>
              {ownMailboxes.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-600">
                  <p>No mailbox connected yet.</p>
                  <button
                    type="button"
                    onClick={() => void connectMyMailbox()}
                    disabled={addingMyMailbox}
                    className="mt-3 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-60"
                  >
                    {addingMyMailbox ? 'Opening…' : 'Connect my Gmail'}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          {scopedNeedsAttention.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-3 text-lg font-bold text-slate-900">
                Action required
                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                  {scopedNeedsAttention.length}
                </span>
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {ownMailboxes.length > 1 && <th className="px-4 py-3">Person</th>}
                      <th className="px-4 py-3">Subject</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">View in Gmail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {scopedNeedsAttention.map((c) => (
                      <tr key={c.conversation_id} className="hover:bg-slate-50/60">
                        {ownMailboxes.length > 1 && (
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                            {c.employee_name}
                          </td>
                        )}
                        <td className="max-w-[200px] truncate px-4 py-3 text-slate-700">
                          {c.summary || c.short_reason || '(no subject)'}
                        </td>
                        <td className="px-4 py-3">{statusBadge(c.follow_up_status)}</td>
                        <td className="px-4 py-3">
                          <a
                            href={c.open_gmail_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-brand-600 hover:underline"
                          >
                            View in Gmail
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="mt-10">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-bold text-slate-900">
                All conversations
                <span className="ml-2 text-sm font-normal text-slate-400">
                  ({scopedConversations.length})
                </span>
              </h2>
              <div className="flex flex-wrap gap-2">
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                >
                  <option value="">All statuses</option>
                  <option value="MISSED">Missed</option>
                  <option value="PENDING">Pending</option>
                  <option value="DONE">Done</option>
                </select>
                <select
                  value={filterPriority}
                  onChange={(e) => setFilterPriority(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                >
                  <option value="">All priorities</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </select>
              </div>
            </div>
            {scopedConversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-600 shadow-card">
                No conversations yet.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {ownMailboxes.length > 1 && <th className="px-4 py-3">Person</th>}
                      <th className="px-4 py-3">Subject</th>
                      <th className="px-4 py-3">Client</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Delay / SLA</th>
                      <th className="px-4 py-3">View in Gmail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {scopedConversations.map((c) => (
                      <tr key={c.conversation_id} className="hover:bg-slate-50/60">
                        {ownMailboxes.length > 1 && (
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                            {c.employee_name}
                          </td>
                        )}
                        <td className="max-w-[200px] truncate px-4 py-3 text-slate-700">
                          {c.summary || c.short_reason || '(no subject)'}
                        </td>
                        <td className="max-w-[140px] truncate px-4 py-3 text-xs text-slate-500">
                          {c.client_email || '—'}
                        </td>
                        <td className="px-4 py-3">{statusBadge(c.follow_up_status)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                          {Number(c.delay_hours).toFixed(1)}h / {c.sla_hours}h SLA
                        </td>
                        <td className="px-4 py-3">
                          <a
                            href={c.open_gmail_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-medium text-brand-600 hover:underline"
                          >
                            View in Gmail
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

export default function ManagerMyMailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <PageSkeleton />
        </div>
      }
    >
      <ManagerMyMailInner />
    </Suspense>
  );
}
