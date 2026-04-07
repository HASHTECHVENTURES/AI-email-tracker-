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
import { apiFetch, oauthErrorMessage, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import { TrackedMailboxCard } from '@/components/my-email/TrackedMailboxCard';

type Mailbox = {
  id: string;
  name: string;
  email: string;
  /** `SELF` = CEO-added; `TEAM` / missing = org / manager mail — used to split UI sections */
  mailbox_type?: 'SELF' | 'TEAM' | null;
  /** Set by API for CEO: this row is a department manager’s inbox (not a generic team mailbox). */
  is_manager_mailbox?: boolean;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
  ai_enabled?: boolean;
};

/** Same fallback as self-tracking when `sla_hours_default` is null (see backend self-tracking.service). */
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

type DashboardPayload = {
  mailboxes: Mailbox[];
  needs_attention: ConversationRow[];
  conversations: ConversationRow[];
  stats: { total: number; pending: number; missed: number; done: number };
  person_filter_options: { id: string; name: string }[];
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

/** `datetime-local` value in the user's local timezone */
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

function MyEmailPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();

  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Add mailbox form
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  /** Sidebar hash drives separate screens — CEO inbox is not one long scroll with manager/team below. */
  const [myEmailTab, setMyEmailTab] = useState<'ceo' | 'manager' | 'team'>('ceo');

  // Filters
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterMailbox, setFilterMailbox] = useState('');

  // Deletion
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [slaDraftById, setSlaDraftById] = useState<Record<string, string>>({});
  const [slaSavingId, setSlaSavingId] = useState<string | null>(null);

  const [trackingDraftById, setTrackingDraftById] = useState<
    Record<string, string>
  >({});
  const [trackingSavingId, setTrackingSavingId] = useState<string | null>(null);

  /** Latest filters for stable `loadDashboard` — avoids full-page skeleton on every filter change. */
  const filterRef = useRef({
    status: filterStatus,
    priority: filterPriority,
    mailbox: filterMailbox,
  });
  filterRef.current = {
    status: filterStatus,
    priority: filterPriority,
    mailbox: filterMailbox,
  };

  /** After first successful load for this user, filter-only refetches skip the page skeleton. */
  const dashboardLoadedForUserId = useRef<string | null>(null);

  const loadDashboard = useCallback(async (t: string) => {
    const f = filterRef.current;
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.priority) qs.set('priority', f.priority);
    if (f.mailbox) qs.set('mailbox_id', f.mailbox);
    const q = qs.toString();
      const res = await apiFetch(
      `/self-tracking/dashboard${q ? `?${q}` : ''}`,
      t,
    );
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not load mailbox data.'));
      setDash(null);
      return;
    }
    const body = (await res.json()) as DashboardPayload;
    setDash(body);
    setError(null);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      dashboardLoadedForUserId.current = null;
      router.replace('/auth');
      return;
    }
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    /** My Email is CEO-only — managers and employees use Dashboard / their tools. */
    if (me.role !== 'CEO') {
      router.replace('/dashboard');
      return;
    }

    const showFullPageLoad = dashboardLoadedForUserId.current !== me.id;
    let cancelled = false;

    const run = async () => {
      if (showFullPageLoad) setLoading(true);
      try {
        await loadDashboard(token);
        if (!cancelled) {
          dashboardLoadedForUserId.current = me.id;
        }
      } finally {
        if (!cancelled && showFullPageLoad) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [authLoading, me, token, router, loadDashboard]);

  useEffect(() => {
    if (!token || !me || me.role !== 'CEO') return;
    const id = window.setTimeout(() => {
      void loadDashboard(token);
    }, 180);
    return () => clearTimeout(id);
  }, [token, me, filterStatus, filterPriority, filterMailbox, loadDashboard]);

  useEffect(() => {
    const syncTab = () => {
      const h = typeof window !== 'undefined' ? window.location.hash : '';
      if (h === '#manager-mailboxes') setMyEmailTab('manager');
      else if (h === '#team-mailboxes-ceo') setMyEmailTab('team');
      else setMyEmailTab('ceo');
    };
    syncTab();
    window.addEventListener('hashchange', syncTab);
    return () => window.removeEventListener('hashchange', syncTab);
  }, []);

  useEffect(() => {
    if (myEmailTab !== 'team') setShowAddForm(false);
  }, [myEmailTab]);

  useEffect(() => {
    setFilterMailbox('');
  }, [myEmailTab]);

  // Handle OAuth redirect back
  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;

    if (oauthErr) setError(oauthErrorMessage(oauthErr));
    if (connected === '1') {
      setSuccess('Gmail connected successfully.');
      void loadDashboard(token);
    }

    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id'])
      params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [authLoading, token, searchParams, pathname, router, loadDashboard]);

  // Auto-clear success after 4s
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
    window.location.href = body.url;
  }

  /** CEO’s own mailbox only — uses session profile; also sends name/email so older APIs still work. */
  async function connectMyInbox() {
    if (!token || !me) return;
    const profileEmail = (me.email ?? '').trim();
    if (!profileEmail) {
      setError('Your profile has no email address. Update it in Settings or contact support.');
      return;
    }
    const profileName =
      (me.full_name ?? '').trim() ||
      profileEmail.split('@')[0] ||
      'Me';

    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch('/self-tracking/mailboxes', token, {
        method: 'POST',
        body: JSON.stringify({
          use_my_profile: true,
          name: profileName,
          email: profileEmail,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not set up your mailbox',
        );
        return;
      }
      const data = (await res.json()) as { mailbox?: { id: string } };
      const id = data.mailbox?.id;
      if (id) {
        setSuccess('Opening Google to connect your inbox…');
        await connectGmail(id);
        return;
      }
      setError('Could not create your mailbox');
    } finally {
      setAdding(false);
    }
  }

  async function addMailbox() {
    if (!token) return;
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch('/self-tracking/mailboxes', token, {
        method: 'POST',
        body: JSON.stringify({ name: addName.trim(), email: addEmail.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not add mailbox',
        );
        return;
      }
      setAddName('');
      setAddEmail('');
      setShowAddForm(false);
      setSuccess('Mailbox added. Connect Gmail to start tracking.');
      await loadDashboard(token);
    } finally {
      setAdding(false);
    }
  }

  async function removeMailbox(id: string) {
    if (!token) return;
    if (
      !window.confirm('Remove this tracked mailbox and all its conversations?')
    )
      return;
    setDeletingId(id);
    try {
      const res = await apiFetch(
        `/self-tracking/mailboxes/${encodeURIComponent(id)}`,
        token,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not remove mailbox',
        );
        return;
      }
      setSuccess('Mailbox removed.');
      await loadDashboard(token);
    } finally {
      setDeletingId(null);
    }
  }

  const ceoEmailNorm = me?.email?.trim().toLowerCase() ?? '';

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
      setSuccess(`Saved ${value}h response-time target for this inbox.`);
      await loadDashboard(token);
    } finally {
      setSlaSavingId(null);
    }
  }

  function trackingInputValue(mb: Mailbox): string {
    if (trackingDraftById[mb.id] !== undefined) {
      return trackingDraftById[mb.id];
    }
    return mb.tracking_start_at ? toDatetimeLocalValue(mb.tracking_start_at) : '';
  }

  async function saveMailboxTrackingStart(mb: Mailbox) {
    if (!token) return;
    setError(null);
    const raw = trackingInputValue(mb).trim();
    if (!raw) {
      setError('Choose a date and time for when tracking should start.');
      return;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      setError('That date and time is not valid.');
      return;
    }
    setTrackingSavingId(mb.id);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/tracking-start`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ tracking_start_at: parsed.toISOString() }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not save tracking start',
        );
        return;
      }
      setTrackingDraftById((prev) => {
        const next = { ...prev };
        delete next[mb.id];
        return next;
      });
      setSuccess('Tracking start time updated.');
      await loadDashboard(token);
    } finally {
      setTrackingSavingId(null);
    }
  }

  // Filtered conversations from the dashboard payload
  const conversations = useMemo(
    () => dash?.conversations ?? [],
    [dash],
  );
  const needsAttention = useMemo(
    () => dash?.needs_attention ?? [],
    [dash],
  );
  const stats = dash?.stats ?? { total: 0, pending: 0, missed: 0, done: 0 };
  const mailboxes = dash?.mailboxes ?? [];
  const personOptions = dash?.person_filter_options ?? [];

  /**
   * Your inbox = every mailbox whose **email matches your CEO login** — whether it was created as
   * self-tracking (Connect my Gmail) or as a team/org row (Employees). Same address always lists here.
   */
  const ownMailboxes = useMemo(
    () =>
      mailboxes.filter(
        (mb) =>
          ceoEmailNorm !== '' &&
          mb.email.trim().toLowerCase() === ceoEmailNorm,
      ),
    [mailboxes, ceoEmailNorm],
  );
  /** Department managers only — matches HEAD user in org (not every IC). */
  const managerMailboxes = useMemo(
    () =>
      mailboxes.filter((mb) => {
        if (ceoEmailNorm !== '' && mb.email.trim().toLowerCase() === ceoEmailNorm) {
          return false;
        }
        return mb.is_manager_mailbox === true;
      }),
    [mailboxes, ceoEmailNorm],
  );

  /** Individual contributors & other team mailboxes (not the CEO inbox, not a manager row). */
  const teamMailboxesOnly = useMemo(
    () =>
      mailboxes.filter((mb) => {
        if (ceoEmailNorm !== '' && mb.email.trim().toLowerCase() === ceoEmailNorm) {
          return false;
        }
        return mb.is_manager_mailbox !== true;
      }),
    [mailboxes, ceoEmailNorm],
  );

  const scopeMailboxIds = useMemo(() => {
    const ids = new Set<string>();
    if (myEmailTab === 'ceo') {
      ownMailboxes.forEach((m) => ids.add(m.id));
    } else if (myEmailTab === 'manager') {
      managerMailboxes.forEach((m) => ids.add(m.id));
    } else {
      teamMailboxesOnly.forEach((m) => ids.add(m.id));
    }
    return ids;
  }, [myEmailTab, ownMailboxes, managerMailboxes, teamMailboxesOnly]);

  const scopedConversations = useMemo(
    () => conversations.filter((c) => scopeMailboxIds.has(c.employee_id)),
    [conversations, scopeMailboxIds],
  );
  const scopedNeedsAttention = useMemo(
    () => needsAttention.filter((c) => scopeMailboxIds.has(c.employee_id)),
    [needsAttention, scopeMailboxIds],
  );
  const scopedStats = useMemo(() => {
    const conv = scopedConversations;
    return {
      total: conv.length,
      pending: conv.filter((c) => c.follow_up_status === 'PENDING').length,
      missed: conv.filter((c) => c.follow_up_status === 'MISSED').length,
      done: conv.filter((c) => c.follow_up_status === 'DONE').length,
    };
  }, [scopedConversations]);

  const scopedPersonOptions = useMemo(
    () => personOptions.filter((p) => scopeMailboxIds.has(p.id)),
    [personOptions, scopeMailboxIds],
  );

  const mailboxesForInboxShortcuts = useMemo(() => {
    if (myEmailTab === 'ceo') return ownMailboxes;
    if (myEmailTab === 'manager') return managerMailboxes;
    return teamMailboxesOnly;
  }, [myEmailTab, ownMailboxes, managerMailboxes, teamMailboxesOnly]);

  if (!me || authLoading) {
    return (
      <AppShell
        role="CEO"
        title="My Email"
        subtitle="Loading..."
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  if (me.role === 'PLATFORM_ADMIN') {
    return (
      <AppShell
        role="PLATFORM_ADMIN"
        title="My Email"
        subtitle="Redirecting…"
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  if (me.role !== 'CEO') {
    return (
      <AppShell
        role={me.role}
        title="My Email"
        subtitle="Redirecting to your workspace…"
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  const pageTitle =
    myEmailTab === 'manager'
      ? 'Manager mail'
      : myEmailTab === 'team'
        ? 'Team mail'
        : 'My Email';
  const shellSubtitle =
    myEmailTab === 'ceo'
      ? 'Your CEO inbox only.'
      : myEmailTab === 'manager'
        ? 'Department heads’ tracked inboxes.'
        : 'Individual contributors and other org mailboxes (not your CEO login).';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title={pageTitle}
      subtitle={shellSubtitle}
      onSignOut={() => void ctxSignOut()}
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 font-semibold underline"
          >
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
        <>
          {/* ── KPI strip (scoped to current tab: CEO / manager / team) ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              {
                label: 'Needs attention',
                value: scopedNeedsAttention.length,
                color: 'text-red-600',
              },
              {
                label: 'Pending',
                value: scopedStats.pending,
                color: 'text-amber-600',
              },
              {
                label: 'Missed SLA',
                value: scopedStats.missed,
                color: 'text-red-600',
              },
              {
                label: 'Resolved',
                value: scopedStats.done,
                color: 'text-emerald-600',
              },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {kpi.label}
                </p>
                <p className={`mt-1 text-2xl font-bold ${kpi.color}`}>
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>

          {/* ── Mailboxes: CEO / Manager / Team are separate views (sidebar hash), not one scroll ── */}
          <section>
            {myEmailTab === 'ceo' ? (
              <>
                <div className="mb-3">
                  <h2 className="text-lg font-bold text-slate-900">Your inbox (CEO)</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Only your CEO login mailbox appears here.
                  </p>
                </div>

                {mailboxes.length === 0 && (
                  <div className="mb-4 rounded-2xl border border-brand-200/80 bg-gradient-to-br from-indigo-50/90 to-white p-6 shadow-card">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                      Your inbox (CEO)
                    </p>
                    <h3 className="mt-1 text-base font-bold text-slate-900">
                      Connect your own Gmail
                    </h3>
                    <button
                      type="button"
                      onClick={() => void connectMyInbox()}
                      disabled={adding}
                      className="mt-4 w-full rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:opacity-95 disabled:opacity-60 sm:w-auto"
                    >
                      {adding ? 'Opening…' : 'Connect my Gmail'}
                    </button>
                  </div>
                )}

                {mailboxes.length > 0 ? (
                  <div className="mt-2">
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {ownMailboxes.map((mb) => (
                        <TrackedMailboxCard
                          key={mb.id}
                          mb={mb}
                          ceoEmailNorm={ceoEmailNorm}
                          trackingValue={trackingInputValue(mb)}
                          slaValue={mailboxSlaInputValue(mb)}
                          onTrackingChange={(v) =>
                            setTrackingDraftById((p) => ({ ...p, [mb.id]: v }))
                          }
                          onSlaChange={(v) =>
                            setSlaDraftById((p) => ({ ...p, [mb.id]: v }))
                          }
                          onSaveTrackingStart={() =>
                            void saveMailboxTrackingStart(mb)
                          }
                          onSaveSla={() => void saveMailboxSla(mb)}
                          onConnectGmail={() => void connectGmail(mb.id)}
                          onRemove={() => void removeMailbox(mb.id)}
                          trackingSaving={trackingSavingId === mb.id}
                          slaSaving={slaSavingId === mb.id}
                          removing={deletingId === mb.id}
                          relativeTime={relativeTime}
                          absoluteTime={absoluteTime}
                        />
                      ))}
                    </div>
                    {ownMailboxes.length === 0 ? (
                      <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-600">
                        <p>
                          Your work inbox isn&apos;t listed yet. Use{' '}
                          <strong className="font-medium text-slate-800">Connect my Gmail</strong> so
                          the row matches your CEO email.
                        </p>
                        <button
                          type="button"
                          onClick={() => void connectMyInbox()}
                          disabled={adding}
                          className="mt-3 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-60"
                        >
                          {adding ? 'Opening…' : 'Connect my Gmail'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {myEmailTab === 'manager' ? (
              <div
                id="manager-mailboxes"
                className="scroll-mt-24 rounded-2xl border border-slate-100 bg-slate-50/40 px-4 py-5 sm:px-6"
              >
                <h2 className="text-lg font-bold text-slate-900">Manager mailboxes</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Department heads only.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {managerMailboxes.map((mb) => (
                    <TrackedMailboxCard
                      key={mb.id}
                      mb={mb}
                      ceoEmailNorm={ceoEmailNorm}
                      trackingValue={trackingInputValue(mb)}
                      slaValue={mailboxSlaInputValue(mb)}
                      onTrackingChange={(v) =>
                        setTrackingDraftById((p) => ({ ...p, [mb.id]: v }))
                      }
                      onSlaChange={(v) =>
                        setSlaDraftById((p) => ({ ...p, [mb.id]: v }))
                      }
                      onSaveTrackingStart={() =>
                        void saveMailboxTrackingStart(mb)
                      }
                      onSaveSla={() => void saveMailboxSla(mb)}
                      onConnectGmail={() => void connectGmail(mb.id)}
                      onRemove={() => void removeMailbox(mb.id)}
                      trackingSaving={trackingSavingId === mb.id}
                      slaSaving={slaSavingId === mb.id}
                      removing={deletingId === mb.id}
                      relativeTime={relativeTime}
                      absoluteTime={absoluteTime}
                    />
                  ))}
                </div>
                {managerMailboxes.length === 0 ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    No manager inboxes yet.
                  </p>
                ) : null}
              </div>
            ) : null}

            {myEmailTab === 'team' ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-bold text-slate-900">Team mailboxes</h2>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm((v) => {
                        const open = !v;
                        if (open) {
                          setAddName('');
                          setAddEmail('');
                        }
                        return open;
                      });
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                  >
                    {showAddForm ? 'Cancel' : '+ Add another mailbox'}
                  </button>
                </div>

                {showAddForm && (
                  <div className="mb-4 rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
                    <p className="mb-3 text-sm font-semibold text-slate-700">
                      Add someone else&apos;s mailbox (IC, shared inbox, etc.)
                    </p>
                    <p className="mb-3 text-xs text-slate-500">
                      Enter <strong>their</strong> full name and work email — not yours.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="Full name"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                      <input
                        type="email"
                        placeholder="Email address"
                        value={addEmail}
                        onChange={(e) => setAddEmail(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void addMailbox()}
                        disabled={adding || !addName.trim() || !addEmail.trim()}
                        className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-50"
                      >
                        {adding ? 'Adding...' : 'Add mailbox'}
                      </button>
                    </div>
                  </div>
                )}

                {mailboxes.length === 0 && showAddForm ? (
                  <div className="mb-4 rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center shadow-card">
                    <p className="text-sm text-slate-600">
                      Fill in the form above to add a tracked mailbox, or cancel and add people from{' '}
                      <strong>Employees</strong> first.
                    </p>
                  </div>
                ) : null}

                <div
                  id="team-mailboxes-ceo"
                  className="scroll-mt-24 rounded-2xl border border-slate-100 bg-white px-4 py-5 shadow-sm sm:px-6"
                >
                  <p className="text-xs text-slate-600">
                    Individual contributors and other org mail — <strong>not</strong> your CEO login and{' '}
                    <strong>not</strong> department manager rows (those are under Manager mail).
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {teamMailboxesOnly.map((mb) => (
                      <TrackedMailboxCard
                        key={mb.id}
                        mb={mb}
                        ceoEmailNorm={ceoEmailNorm}
                        trackingValue={trackingInputValue(mb)}
                        slaValue={mailboxSlaInputValue(mb)}
                        onTrackingChange={(v) =>
                          setTrackingDraftById((p) => ({ ...p, [mb.id]: v }))
                        }
                        onSlaChange={(v) =>
                          setSlaDraftById((p) => ({ ...p, [mb.id]: v }))
                        }
                        onSaveTrackingStart={() =>
                          void saveMailboxTrackingStart(mb)
                        }
                        onSaveSla={() => void saveMailboxSla(mb)}
                        onConnectGmail={() => void connectGmail(mb.id)}
                        onRemove={() => void removeMailbox(mb.id)}
                        trackingSaving={trackingSavingId === mb.id}
                        slaSaving={slaSavingId === mb.id}
                        removing={deletingId === mb.id}
                        relativeTime={relativeTime}
                        absoluteTime={absoluteTime}
                      />
                    ))}
                  </div>
                  {teamMailboxesOnly.length === 0 ? (
                    <p className="mt-3 text-center text-sm text-slate-500">
                      No team mailboxes yet. Add people on <strong>Employees</strong> or use{' '}
                      <strong>+ Add another mailbox</strong> above.
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>

          {/* ── Action required (tab-scoped) ── */}
          {scopedNeedsAttention.length > 0 && (
            <section>
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
                      {scopedPersonOptions.length > 1 && (
                        <th className="px-4 py-3">Person</th>
                      )}
                      <th className="px-4 py-3">Subject</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Priority</th>
                      <th className="px-4 py-3">Delay / SLA</th>
                      <th className="px-4 py-3">Last activity</th>
                      <th className="px-4 py-3">View in Gmail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {scopedNeedsAttention.map((c) => (
                      <tr key={c.conversation_id} className="hover:bg-slate-50/60">
                        {scopedPersonOptions.length > 1 && (
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                            {c.employee_name}
                          </td>
                        )}
                        <td className="max-w-[200px] truncate px-4 py-3 text-slate-700">
                          {c.summary || c.short_reason || '(no subject)'}
                        </td>
                        <td className="px-4 py-3">
                          {statusBadge(c.follow_up_status)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5">
                            {priorityDot(c.priority)}
                            <span className="text-xs text-slate-600">
                              {c.priority}
                            </span>
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                          {Number(c.delay_hours).toFixed(1)}h / {c.sla_hours}h SLA
                        </td>
                        <td
                          className="whitespace-nowrap px-4 py-3 text-xs text-slate-500"
                          title={absoluteTime(
                            c.last_employee_reply_at ?? c.last_client_msg_at,
                          )}
                        >
                          {relativeTime(
                            c.last_employee_reply_at ?? c.last_client_msg_at,
                          )}
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
            </section>
          )}

          {/* ── All conversations ── */}
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-bold text-slate-900">
                All conversations
                <span className="ml-2 text-sm font-normal text-slate-400">
                  ({scopedConversations.length})
                </span>
              </h2>
              <div className="flex flex-wrap gap-2">
                {scopedPersonOptions.length > 1 && (
                  <select
                    value={filterMailbox}
                    onChange={(e) => setFilterMailbox(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">All people</option>
                    {scopedPersonOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
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
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 shadow-card sm:p-8">
                <p className="mb-4 text-center text-sm text-slate-600">
                  {scopeMailboxIds.size === 0
                    ? 'No mailboxes in this view yet.'
                    : mailboxesForInboxShortcuts.some((m) => m.gmail_connected)
                      ? 'No conversations yet.'
                      : 'Connect Gmail to start tracking conversations.'}
                </p>
                <div className="overflow-x-auto rounded-xl border border-slate-100 bg-slate-50/80">
                  <table className="w-full text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <thead>
                      <tr className="border-b border-slate-200/80">
                        {scopedPersonOptions.length > 1 ? (
                          <th className="px-4 py-2">Person</th>
                        ) : null}
                        <th className="px-4 py-2">Subject</th>
                        <th className="px-4 py-2">Client</th>
                        <th className="px-4 py-2">Status</th>
                        <th className="px-4 py-2">Priority</th>
                        <th className="px-4 py-2">Delay / SLA</th>
                        <th className="px-4 py-2">Last updated</th>
                        <th className="px-4 py-2">View in Gmail</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td
                          colSpan={scopedPersonOptions.length > 1 ? 8 : 7}
                          className="px-4 py-6 text-center text-sm font-normal normal-case tracking-normal text-slate-500"
                        >
                          No rows yet — your conversation list will populate here.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {scopedPersonOptions.length > 1 && (
                        <th className="px-4 py-3">Person</th>
                      )}
                      <th className="px-4 py-3">Subject</th>
                      <th className="px-4 py-3">Client</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Priority</th>
                      <th className="px-4 py-3">Delay / SLA</th>
                      <th className="px-4 py-3">Last updated</th>
                      <th className="px-4 py-3">View in Gmail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {scopedConversations.map((c) => (
                      <tr
                        key={c.conversation_id}
                        className="hover:bg-slate-50/60"
                      >
                        {scopedPersonOptions.length > 1 && (
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
                        <td className="px-4 py-3">
                          {statusBadge(c.follow_up_status)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5">
                            {priorityDot(c.priority)}
                            <span className="text-xs text-slate-600">
                              {c.priority}
                            </span>
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                          {Number(c.delay_hours).toFixed(1)}h / {c.sla_hours}h SLA
                        </td>
                        <td
                          className="whitespace-nowrap px-4 py-3 text-xs text-slate-500"
                          title={absoluteTime(c.updated_at)}
                        >
                          {relativeTime(c.updated_at)}
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

export default function MyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <PageSkeleton />
        </div>
      }
    >
      <MyEmailPageInner />
    </Suspense>
  );
}
