'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { useAuth, type AuthMe as Me } from '@/lib/auth-context';
import { buildManagerReplyMailto } from '@/lib/managerReplyMailto';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import { Badge } from '@/components/Badge';
import { ReassignModal } from '@/components/ReassignModal';

type SystemStatus = {
  is_active: boolean;
  last_sync_at: string | null;
  employees_tracked: number;
  ai_status: boolean;
  email_crawl_enabled?: boolean;
  seconds_until_next_ingestion?: number | null;
  last_report_at?: string | null;
  seconds_until_next_report?: number | null;
  smtp_configured?: boolean;
  ai_model_configured?: boolean;
};

type ConversationRow = {
  conversation_id: string;
  employee_id: string;
  employee_name: string;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  sla_hours: number;
  summary: string;
  short_reason: string;
  reason: string;
  open_gmail_link: string;
};

type DashboardPayload = {
  needs_attention: ConversationRow[];
  ai_insights: { lines: string[]; last_updated_at: string | null };
  conversations: ConversationRow[];
  onboarding: {
    show: boolean;
    employee_count: number;
    mailboxes_connected: number;
    state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY';
    employee_added: boolean;
    waiting_for_sync: boolean;
  };
  employee_filter_options: { id: string; name: string }[];
  my_followups?: { missed: number; pending: number; done: number };
};

type TeamAlertItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  from_manager_name: string | null;
  from_manager_email: string | null;
};

async function parseApiErrorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown; error?: string };
    if (typeof j.message === 'string') return j.message;
    if (typeof j.error === 'string') return j.error;
    if (j.message != null && typeof j.message === 'object') return JSON.stringify(j.message);
  } catch {
    /* non-JSON body */
  }
  return `Request failed (${res.status})`;
}

export default function DashboardPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [syncCountdownSec, setSyncCountdownSec] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [modal, setModal] = useState<ConversationRow | null>(null);
  const [reassignTarget, setReassignTarget] = useState<ConversationRow | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [teamAlerts, setTeamAlerts] = useState<{ items: TeamAlertItem[]; unread_count: number } | null>(null);

  const buildDashboardPath = useCallback(() => {
    const qs = new URLSearchParams();
    if (filterStatus) qs.set('status', filterStatus);
    if (filterPriority) qs.set('priority', filterPriority);
    if (filterEmployee && me?.role !== 'EMPLOYEE') qs.set('employee_id', filterEmployee);
    const q = qs.toString();
    return `/dashboard${q ? `?${q}` : ''}`;
  }, [filterStatus, filterPriority, filterEmployee, me?.role]);

  const refresh = useCallback(async () => {
    if (!token) return;

    const alertResPromise =
      me?.role === 'EMPLOYEE'
        ? apiFetch('/team-alerts/mine', token)
        : Promise.resolve({ ok: false } as Response);
    const [dRes, sRes, taRes] = await Promise.all([
      apiFetch(buildDashboardPath(), token),
      apiFetch('/system/status', token),
      alertResPromise,
    ]);
    if (dRes.ok) {
      setDash((await dRes.json()) as DashboardPayload);
      setError(null);
    } else {
      if (dRes.status === 401) {
        void ctxSignOut();
        return;
      }
      setError(await parseApiErrorMessage(dRes));
    }
    if (sRes.ok) {
      const nextStatus = (await sRes.json()) as SystemStatus;
      setStatus(nextStatus);
      setSyncCountdownSec(
        nextStatus.email_crawl_enabled === false ? null : (nextStatus.seconds_until_next_ingestion ?? null),
      );
    }
    if (me?.role === 'EMPLOYEE') {
      if (taRes.ok) {
        setTeamAlerts((await taRes.json()) as { items: TeamAlertItem[]; unread_count: number });
      } else {
        setTeamAlerts({ items: [], unread_count: 0 });
      }
    } else {
      setTeamAlerts(null);
    }
  }, [buildDashboardPath, ctxSignOut, me?.role, token]);

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      router.replace('/auth');
      return;
    }
    let cancelled = false;
    (async () => {
      const statusRes = await apiFetch('/auth/status', token);
      if (statusRes.status === 401) {
        void ctxSignOut();
        return;
      }
      if (statusRes.ok) {
        const st = await statusRes.json();
        if (cancelled) return;
        if (st.needs_onboarding) {
          router.replace('/auth');
          return;
        }
      } else if (!cancelled) {
        setError(await parseApiErrorMessage(statusRes));
      }
      void refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, me, token, router]);

  useEffect(() => {
    if (!me || !token) return;
    void refresh();
  }, [me, token, refresh, filterStatus, filterPriority, filterEmployee]);

  useEffect(() => {
    if (!me || !token) return;
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [me, token, refresh]);

  async function dismissTeamAlert(alertId: string) {
    if (!token) return;
    const res = await apiFetch(`/team-alerts/read/${encodeURIComponent(alertId)}`, token, {
      method: 'PATCH',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j.message as string) || 'Could not dismiss alert');
      return;
    }
    await refresh();
  }

  async function markDone(conversationId: string) {
    if (!token) return;
    setActionLoading(true);
    try {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/mark-done`, token, {
        method: 'POST',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not update');
        return;
      }
      setModal(null);
      await refresh();
    } finally {
      setActionLoading(false);
    }
  }

  const lastSyncLabel = useMemo(() => {
    if (!status?.last_sync_at) return null;
    return new Date(status.last_sync_at).toLocaleString();
  }, [status?.last_sync_at]);

  useEffect(() => {
    if (syncCountdownSec == null) return;
    const id = window.setInterval(() => {
      setSyncCountdownSec((prev) => {
        if (prev == null) return prev;
        return prev > 0 ? prev - 1 : 0;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncCountdownSec != null]);

  const syncCountdownLabel = useMemo(() => {
    if (syncCountdownSec == null) return null;
    const mins = Math.floor(syncCountdownSec / 60);
    const secs = syncCountdownSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, [syncCountdownSec]);

  /** Must run before any early return — same hook order when `me` is still null. */
  const kpi = useMemo(() => {
    const conv = dash?.conversations ?? [];
    return {
      needsAttention: dash?.needs_attention?.length ?? 0,
      pending: conv.filter((c) => c.follow_up_status === 'PENDING').length,
      missed: conv.filter((c) => c.follow_up_status === 'MISSED').length,
      resolved: conv.filter((c) => c.follow_up_status === 'DONE').length,
    };
  }, [dash]);

  const employeePerformance = useMemo(() => {
    const conv = dash?.conversations ?? [];
    const attn = dash?.needs_attention ?? [];
    const byId = new Map<
      string,
      {
        employee_id: string;
        employee: string;
        attention: number;
        missed: number;
        pending: number;
        resolved: number;
      }
    >();
    for (const c of conv) {
      const id = c.employee_id || c.employee_name;
      const en = c.employee_name?.trim() || 'Unknown';
      if (!byId.has(id)) {
        byId.set(id, { employee_id: c.employee_id, employee: en, attention: 0, missed: 0, pending: 0, resolved: 0 });
      }
      const r = byId.get(id)!;
      if (c.follow_up_status === 'MISSED') r.missed++;
      else if (c.follow_up_status === 'PENDING') r.pending++;
      else if (c.follow_up_status === 'DONE') r.resolved++;
    }
    for (const c of attn) {
      const id = c.employee_id || c.employee_name;
      const en = c.employee_name?.trim() || 'Unknown';
      if (!byId.has(id)) {
        byId.set(id, { employee_id: c.employee_id, employee: en, attention: 0, missed: 0, pending: 0, resolved: 0 });
      }
      byId.get(id)!.attention++;
    }
    return Array.from(byId.values()).sort(
      (a, b) => b.attention - a.attention || b.missed - a.missed,
    );
  }, [dash]);

  if (!me || authLoading) {
    return (
      <AppShell
        role="CEO"
        title="Dashboard"
        subtitle="Loading…"
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  const isEmployee = me.role === 'EMPLOYEE';
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';
  const isCeo = !isEmployee && !isHead;
  const dashboardSubtitle = isEmployee
    ? 'Your follow-ups and SLA.'
    : isHead
      ? 'What needs you right now — then how your team is trending.'
      : 'Company pulse and priorities.';

  /** Live next-sync countdown: useful for managers/employees; hidden on CEO overview. */
  const nextSyncLabelForRole = isCeo ? null : syncCountdownLabel;

  if (!dash) {
    return (
      <AppShell
        role={me.role}
        companyName={me.company_name ?? null}
        title={isEmployee ? 'My follow-ups' : isHead ? 'Workspace' : 'Overview'}
        subtitle={dashboardSubtitle}
        lastSyncLabel={lastSyncLabel}
        nextIngestionCountdownLabel={nextSyncLabelForRole}
        isActive={status?.is_active}
        aiBriefingsEnabled={status == null ? undefined : status.ai_status}
        mailboxCrawlEnabled={status == null ? undefined : status.email_crawl_enabled !== false}
        onRefresh={() => void refresh()}
        onSignOut={() => void ctxSignOut()}
      >
        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-900 shadow-sm"
          >
            <p className="font-semibold">Couldn&apos;t load dashboard</p>
            <p className="mt-2 text-red-800/95">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError(null);
                void refresh();
              }}
              className="mt-4 rounded-lg bg-red-100 px-4 py-2 text-xs font-semibold text-red-950 transition hover:bg-red-200"
            >
              Retry
            </button>
            <p className="mt-3 text-xs text-red-700/90">
              If this keeps happening, confirm Vercel has{' '}
              <code className="rounded bg-red-100/80 px-1 py-0.5">NEXT_PUBLIC_API_URL</code> set to your Railway
              API URL (with <code className="rounded bg-red-100/80 px-1 py-0.5">https://</code>) and redeploy.
            </p>
          </div>
        ) : (
          <PageSkeleton />
        )}
      </AppShell>
    );
  }

  const attentionCount = kpi.needsAttention;
  const pendingCount = kpi.pending;
  const missedCount = kpi.missed;
  const resolvedCount = kpi.resolved;
  const conversations = dash.conversations ?? [];
  const needsAttentionRows = dash.needs_attention ?? [];

  const cardClass =
    'rounded-2xl border border-slate-200/60 bg-surface-card p-6 shadow-card';

  const conversationsBrowse = (
    <>
      <div id="conv-filters" className="mb-4 flex flex-wrap gap-4">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All statuses</option>
          <option value="DONE">Done</option>
          <option value="PENDING">Pending</option>
          <option value="MISSED">Missed</option>
        </select>
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All priorities</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
        {!isEmployee ? (
          <select
            value={filterEmployee}
            onChange={(e) => setFilterEmployee(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All employees</option>
            {(dash?.employee_filter_options ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {!conversations.length ? (
        <p className="text-sm text-slate-500">No threads match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Client</th>
                {!isEmployee ? <th className="px-4 py-3">Employee</th> : null}
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Delay / SLA</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {conversations.map((c) => (
                <tr key={c.conversation_id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 font-medium text-slate-800">{c.client_email ?? '—'}</td>
                  {!isEmployee ? <td className="px-4 py-3 text-slate-600">{c.employee_name}</td> : null}
                  <td className="px-4 py-3">
                    <Badge
                      tone={
                        c.follow_up_status === 'MISSED'
                          ? 'missed'
                          : c.follow_up_status === 'PENDING'
                            ? 'pending'
                            : 'done'
                      }
                    >
                      {c.follow_up_status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={c.priority === 'HIGH' ? 'high' : c.priority === 'MEDIUM' ? 'medium' : 'low'}>
                      {c.priority}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">
                    {Number(c.delay_hours).toFixed(1)}h / {Number(c.sla_hours).toFixed(0)}h
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => window.open(c.open_gmail_link, '_blank', 'noopener,noreferrer')}
                        className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Open Gmail
                      </button>
                      <button
                        type="button"
                        onClick={() => void markDone(c.conversation_id)}
                        disabled={actionLoading}
                        className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                      >
                        Resolve
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  return (
    <>
      <AppShell
        role={me.role}
        companyName={me.company_name ?? null}
        title={isEmployee ? 'My follow-ups' : isHead ? 'Workspace' : 'Overview'}
        subtitle={dashboardSubtitle}
        lastSyncLabel={lastSyncLabel}
        nextIngestionCountdownLabel={nextSyncLabelForRole}
        isActive={status?.is_active}
        aiBriefingsEnabled={status == null ? undefined : status.ai_status}
        mailboxCrawlEnabled={status == null ? undefined : status.email_crawl_enabled !== false}
        onRefresh={() => void refresh()}
        onSignOut={() => void ctxSignOut()}
      >
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(
            [
              {
                label: 'Needs attention',
                value: attentionCount,
                bar: 'from-brand-600 to-violet-500',
              },
              { label: 'Pending', value: pendingCount, bar: 'from-amber-400 to-amber-600' },
              { label: 'Missed SLA', value: missedCount, bar: 'from-red-400 to-red-600' },
              { label: 'Resolved', value: resolvedCount, bar: 'from-emerald-400 to-teal-600' },
            ] as const
          ).map((k) => (
            <div
              key={k.label}
              className="relative overflow-hidden rounded-2xl border border-slate-200/60 bg-surface-card p-6 shadow-card"
            >
              <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${k.bar}`} aria-hidden />
              <p className="text-3xl font-bold tabular-nums tracking-tight text-slate-900">{k.value}</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{k.label}</p>
            </div>
          ))}
        </section>

        {isEmployee && teamAlerts?.items?.some((a) => !a.read_at) ? (
          <div className="space-y-3" role="region" aria-label="Messages from your manager">
            {(teamAlerts.items ?? [])
              .filter((a) => !a.read_at)
              .map((a) => {
                const replyHref = buildManagerReplyMailto(a.from_manager_email, a.body);
                return (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-gray-900 shadow-sm sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Manager message</p>
                    <p className="mt-1 whitespace-pre-wrap text-gray-800">{a.body}</p>
                    <p className="mt-2 text-xs text-gray-500">
                      From {a.from_manager_name?.trim() || 'Your manager'} · {new Date(a.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                    {replyHref ? (
                      <a
                        href={replyHref}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-center text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                      >
                        Reply
                      </a>
                    ) : (
                      <span
                        className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-400"
                        title="Manager email not available"
                      >
                        Reply
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void dismissTeamAlert(a.id)}
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                );
              })}
          </div>
        ) : null}

        {isCeo && dash.onboarding?.show ? (
          <section className={cardClass}>
            <h2 className="text-sm font-semibold text-slate-900">Setup</h2>
            <p className="mt-1 text-sm text-slate-500">
              {dash.onboarding?.state ?? '—'} · {dash.onboarding?.employee_count ?? 0} people ·{' '}
              {dash.onboarding?.mailboxes_connected ?? 0} mailboxes
            </p>
          </section>
        ) : null}

        <section className={cardClass}>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Action required</h2>
              <p className="mt-1 text-sm text-slate-500">Threads that need a reply or decision.</p>
            </div>
            {isHead ? (
              <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">
                Your department
              </span>
            ) : null}
          </div>
          {needsAttentionRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-surface-muted/40 px-6 py-14 text-center">
              <p className="text-lg font-semibold text-slate-800">You&apos;re all caught up 🎉</p>
              <p className="mt-2 text-sm text-slate-500">Nothing is waiting on you right now.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
              <table className="min-w-[800px] w-full text-sm">
                <thead className="bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Client</th>
                    {!isEmployee ? <th className="px-4 py-3">Assigned</th> : null}
                    <th className="px-4 py-3">Delay</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {needsAttentionRows.map((c) => (
                    <tr key={c.conversation_id} className="transition-colors hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setModal(c)}
                          className="text-left font-semibold text-slate-900 hover:text-brand-600"
                        >
                          {c.client_email ?? '—'}
                        </button>
                      </td>
                      {!isEmployee ? (
                        <td className="px-4 py-3 text-slate-600">{c.employee_name}</td>
                      ) : null}
                      <td className="px-4 py-3 tabular-nums font-medium text-slate-700">
                        {Number(c.delay_hours).toFixed(1)}h
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={c.priority === 'HIGH' ? 'high' : c.priority === 'MEDIUM' ? 'medium' : 'low'}>
                          {c.priority}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          tone={
                            c.follow_up_status === 'MISSED'
                              ? 'missed'
                              : c.follow_up_status === 'PENDING'
                                ? 'pending'
                                : 'done'
                          }
                        >
                          {c.follow_up_status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <a
                            href={c.open_gmail_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300"
                          >
                            Open Gmail
                          </a>
                          {!isEmployee ? (
                            <button
                              type="button"
                              onClick={() => setReassignTarget(c)}
                              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-brand-200 hover:text-brand-700"
                            >
                              Reassign
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void markDone(c.conversation_id)}
                            disabled={actionLoading}
                            className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
                          >
                            Resolve
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {!isEmployee ? (
          <section className={cardClass}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Team performance</h2>
                <p className="mt-1 text-sm text-slate-500">Volume and outcomes by teammate.</p>
              </div>
              <Link
                href="/employees"
                className="text-sm font-semibold text-brand-600 hover:text-brand-700"
              >
                Open team →
              </Link>
            </div>
            {employeePerformance.length === 0 ? null : (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="min-w-[520px] w-full text-sm">
                  <thead className="bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Teammate</th>
                      <th className="px-4 py-3">Attention</th>
                      <th className="px-4 py-3">Missed</th>
                      <th className="px-4 py-3">Pending</th>
                      <th className="px-4 py-3">Resolved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {employeePerformance.map((row) => (
                      <tr key={row.employee_id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3">
                          <Link
                            href={`/employees?focus=${encodeURIComponent(row.employee_id)}`}
                            className="font-semibold text-slate-900 hover:text-brand-600"
                          >
                            {row.employee}
                          </Link>
                        </td>
                        <td className="px-4 py-3 tabular-nums font-medium text-slate-800">{row.attention}</td>
                        <td className="px-4 py-3 tabular-nums font-medium text-red-600">{row.missed}</td>
                        <td className="px-4 py-3 tabular-nums font-medium text-amber-600">{row.pending}</td>
                        <td className="px-4 py-3 tabular-nums font-medium text-emerald-600">{row.resolved}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        <section id="conversations" className={cardClass}>
          {isHead ? (
            <details className="group">
              <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">All conversations</h2>
                    <p className="mt-1 text-sm text-slate-500">Filter and browse the full list.</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 group-open:hidden">
                    Expand
                  </span>
                  <span className="hidden shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 group-open:inline">
                    Collapse
                  </span>
                </div>
              </summary>
              <div className="mt-6 border-t border-slate-100 pt-6">{conversationsBrowse}</div>
            </details>
          ) : (
            <>
              <h2 className="mb-4 text-lg font-bold text-slate-900">All conversations</h2>
              {conversationsBrowse}
            </>
          )}
        </section>

      </AppShell>

      {reassignTarget ? (
        <ReassignModal
          conversationId={reassignTarget.conversation_id}
          clientEmail={reassignTarget.client_email}
          currentEmployeeName={reassignTarget.employee_name}
          employees={dash.employee_filter_options ?? []}
          onClose={() => setReassignTarget(null)}
          onSuccess={() => {
            setReassignTarget(null);
            void refresh();
          }}
        />
      ) : null}

      {modal ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">{modal.client_email ?? 'Conversation'}</h3>
            <p className="mt-1 text-sm text-gray-500">{modal.employee_name}</p>
            <p className="mt-3 text-sm text-gray-700">{modal.reason || modal.short_reason}</p>
            {modal.summary ? <p className="mt-3 text-sm text-gray-600">{modal.summary}</p> : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => window.open(modal.open_gmail_link, '_blank', 'noopener,noreferrer')}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Open Gmail
              </button>
              <button
                type="button"
                onClick={() => void markDone(modal.conversation_id)}
                disabled={actionLoading}
                className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2 text-sm font-semibold text-white hover:opacity-95 disabled:opacity-50"
              >
                Resolve
              </button>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="ml-auto rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
