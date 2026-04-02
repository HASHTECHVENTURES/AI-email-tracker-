'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { buildManagerReplyMailto } from '@/lib/managerReplyMailto';
import { AppShell } from '@/components/AppShell';
import { Badge } from '@/components/Badge';
import { CeoOverviewCharts } from '@/components/dashboard/CeoOverviewCharts';

type Me = {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  company_name?: string | null;
  role: string;
  department_id: string | null;
};

type SystemStatus = {
  is_active: boolean;
  last_sync_at: string | null;
  employees_tracked: number;
  ai_status: boolean;
  seconds_until_next_ingestion?: number | null;
  last_report_at?: string | null;
  seconds_until_next_report?: number | null;
  smtp_configured?: boolean;
  ai_model_configured?: boolean;
};

type ConversationRow = {
  conversation_id: string;
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

type CeoDepartmentRollup = {
  department_id: string;
  department_name: string;
  manager_name: string | null;
  manager_email: string | null;
  total_threads: number;
  missed: number;
  pending: number;
  done: number;
  need_attention_count: number;
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
  ceo_department_rollups?: CeoDepartmentRollup[];
  /** Some proxies / serializers use camelCase */
  ceoDepartmentRollups?: CeoDepartmentRollup[];
};

function ceoRollupsFromDashboard(d: DashboardPayload | null): CeoDepartmentRollup[] {
  if (!d) return [];
  return d.ceo_department_rollups ?? d.ceoDepartmentRollups ?? [];
}

type EmployeeMailbox = {
  id: string;
  name: string;
  email: string;
  department_name: string;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
};

type AiReportFull = {
  generated_at: string | null;
  key_issues: string[];
  employee_insights: string[];
  patterns: string[];
  recommendation: string;
};

type TeamAlertItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  from_manager_name: string | null;
  from_manager_email: string | null;
};

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [syncCountdownSec, setSyncCountdownSec] = useState<number | null>(null);
  const [reportCountdownSec, setReportCountdownSec] = useState<number | null>(null);
  const [teamMailboxes, setTeamMailboxes] = useState<EmployeeMailbox[]>([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [modal, setModal] = useState<ConversationRow | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [fullReport, setFullReport] = useState<AiReportFull | null>(null);
  const [fullReportOpen, setFullReportOpen] = useState(false);
  const [fullReportLoading, setFullReportLoading] = useState(false);
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
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    const skipEmployeeList = me?.role === 'CEO';
    const alertResPromise =
      me?.role === 'EMPLOYEE'
        ? apiFetch('/team-alerts/mine', session.access_token)
        : Promise.resolve({ ok: false } as Response);
    const [dRes, sRes, eRes, taRes] = await Promise.all([
      apiFetch(buildDashboardPath(), session.access_token),
      apiFetch('/system/status', session.access_token),
      skipEmployeeList
        ? Promise.resolve({ ok: false } as Response)
        : apiFetch('/employees', session.access_token),
      alertResPromise,
    ]);
    if (dRes.ok) setDash((await dRes.json()) as DashboardPayload);
    if (sRes.ok) {
      const nextStatus = (await sRes.json()) as SystemStatus;
      setStatus(nextStatus);
      setSyncCountdownSec(nextStatus.seconds_until_next_ingestion ?? null);
      setReportCountdownSec(
        me?.role === 'EMPLOYEE' ? null : (nextStatus.seconds_until_next_report ?? null),
      );
    }
    if (skipEmployeeList) {
      setTeamMailboxes([]);
    } else if (eRes.ok) {
      setTeamMailboxes((await eRes.json()) as EmployeeMailbox[]);
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
  }, [buildDashboardPath, me?.role]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/auth');
        return;
      }
      const statusRes = await apiFetch('/auth/status', session.access_token);
      if (statusRes.status === 401) {
        await supabase.auth.signOut();
        router.replace('/auth');
        return;
      }
      const st = await statusRes.json();
      if (cancelled) return;
      if (st.needs_onboarding) {
        router.replace('/auth?finish=1');
        return;
      }

      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) {
        if (meRes.status === 401) {
          await supabase.auth.signOut();
          router.replace('/auth');
          return;
        }
        setError('Could not load profile.');
        return;
      }
      setMe((await meRes.json()) as Me);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!me) return;
    void refresh();
  }, [me, refresh, filterStatus, filterPriority, filterEmployee]);

  useEffect(() => {
    if (!me) return;
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [me, refresh]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  async function dismissTeamAlert(alertId: string) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch(`/team-alerts/read/${encodeURIComponent(alertId)}`, session.access_token, {
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
    setActionLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/mark-done`, session.access_token, {
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

  async function generateReportNow() {
    setReportLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch('/dashboard/ai-report/generate', session.access_token);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not generate AI report now');
        return;
      }
      await refresh();
    } finally {
      setReportLoading(false);
    }
  }

  async function openFullAiReport() {
    setFullReportLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch('/dashboard/ai-report', session.access_token);
      const data = (await res.json()) as AiReportFull;
      if (!res.ok) {
        setError('Could not load full AI report.');
        return;
      }
      setFullReport(data);
      setFullReportOpen(true);
    } finally {
      setFullReportLoading(false);
    }
  }

  const lastSyncLabel = useMemo(() => {
    if (!status?.last_sync_at) return null;
    return new Date(status.last_sync_at).toLocaleString();
  }, [status?.last_sync_at]);

  const aiUpdatedMins = useMemo(() => {
    const t = dash?.ai_insights.last_updated_at;
    if (!t) return null;
    const m = Math.floor((Date.now() - new Date(t).getTime()) / 60_000);
    return m < 1 ? 'just now' : `${m} mins ago`;
  }, [dash?.ai_insights.last_updated_at]);

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

  useEffect(() => {
    if (reportCountdownSec == null) return;
    const id = window.setInterval(() => {
      setReportCountdownSec((prev) => {
        if (prev == null) return prev;
        return prev > 0 ? prev - 1 : 0;
      });
    }, 1000);
    return () => clearInterval(id);
    // Recreate timer only when countdown availability toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportCountdownSec != null]);

  const reportCountdownLabel = useMemo(() => {
    if (reportCountdownSec == null) return null;
    const mins = Math.floor(reportCountdownSec / 60);
    const secs = reportCountdownSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, [reportCountdownSec]);

  const syncCountdownLabel = useMemo(() => {
    if (syncCountdownSec == null) return null;
    const mins = Math.floor(syncCountdownSec / 60);
    const secs = syncCountdownSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, [syncCountdownSec]);

  if (!me) {
    return <div className="p-8 text-sm text-gray-500">{error ?? 'Loading...'}</div>;
  }

  const isEmployee = me.role === 'EMPLOYEE';
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';
  const isCeo = !isEmployee && !isHead;
  const dashboardSubtitle = isEmployee
    ? 'Your assigned conversations and SLA status.'
    : isHead
      ? 'Department-scoped follow-ups and AI insights for your team’s mailboxes only.'
      : 'Aggregate health only — charts and AI summary. No client lists or mail details.';
  const attentionCount = dash?.needs_attention.length ?? 0;
  const missedCount = dash?.conversations.filter((c) => c.follow_up_status === 'MISSED').length ?? 0;
  const pendingCount = dash?.conversations.filter((c) => c.follow_up_status === 'PENDING').length ?? 0;
  const resolvedCount = dash?.conversations.filter((c) => c.follow_up_status === 'DONE').length ?? 0;

  const cardClass = isCeo
    ? 'rounded-2xl border border-slate-200/90 bg-white p-6 shadow-md shadow-slate-900/[0.06] ring-1 ring-slate-900/[0.04]'
    : isHead
      ? 'rounded-xl border border-amber-200/80 bg-white p-6 shadow-sm ring-1 ring-amber-900/[0.03]'
      : 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm';

  return (
    <>
      <AppShell
        role={me.role}
        companyName={me.company_name ?? null}
        title={isEmployee ? 'My Follow-ups' : isHead ? 'Team dashboard' : 'Company dashboard'}
        subtitle={dashboardSubtitle}
        lastSyncLabel={lastSyncLabel}
        nextIngestionCountdownLabel={syncCountdownLabel}
        isActive={status?.is_active}
        onRefresh={() => void refresh()}
        onSignOut={() => void signOut()}
      >
        {isCeo ? (
          <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-6 text-white shadow-lg shadow-slate-900/25 sm:p-8">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-200/90">Executive overview</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">Whole organization</h2>
              <p className="mt-1 max-w-xl text-sm text-slate-300">
                Counts and trends only. Sender identities and conversation tables are not shown here — use manager portals for operational detail.
              </p>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
              <div className="rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-semibold tabular-nums text-white">{attentionCount}</p>
                <p className="text-xs font-medium text-rose-200">Need attention</p>
              </div>
              <div className="rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-semibold tabular-nums text-white">{pendingCount}</p>
                <p className="text-xs font-medium text-amber-200">Pending</p>
              </div>
              <div className="rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-semibold tabular-nums text-white">{resolvedCount}</p>
                <p className="text-xs font-medium text-emerald-200">Resolved</p>
              </div>
              <div className="rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm">
                <p className="text-2xl font-semibold tabular-nums text-white">{missedCount}</p>
                <p className="text-xs font-medium text-slate-300">Missed SLA</p>
              </div>
            </div>
          </section>
        ) : isHead ? (
          <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-amber-200/90 bg-gradient-to-r from-amber-50 to-orange-50/80 px-4 py-3 text-sm shadow-sm">
            <span className="font-semibold text-amber-950">Team scope</span>
            <span className="hidden h-4 w-px bg-amber-200 sm:inline" aria-hidden />
            <p className="font-medium text-red-700">{attentionCount} need attention</p>
            <p className="font-medium text-amber-800">{pendingCount} pending</p>
            <p className="font-medium text-emerald-800">{resolvedCount} resolved</p>
            <p className="text-amber-900/80">Missed: {missedCount}</p>
          </section>
        ) : (
          <section className="flex flex-wrap gap-6 text-sm">
            <p className="font-medium text-red-600">🔴 {attentionCount} need attention</p>
            <p className="font-medium text-amber-600">🟠 {pendingCount} pending</p>
            <p className="font-medium text-emerald-600">🟢 {resolvedCount} resolved</p>
            <p className="font-medium text-gray-500">Missed: {missedCount}</p>
          </section>
        )}

        {isEmployee && teamAlerts?.items?.some((a) => !a.read_at) ? (
          <div className="space-y-3" role="region" aria-label="Messages from your manager">
            {teamAlerts.items
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

        {isCeo && dash ? (
          <CeoOverviewCharts
            conversations={dash.conversations}
            needsAttentionCount={attentionCount}
            employeeCount={dash.onboarding.employee_count}
            mailboxesConnected={dash.onboarding.mailboxes_connected}
            departmentRollups={ceoRollupsFromDashboard(dash)}
          />
        ) : null}

        {isCeo && dash?.onboarding?.show ? (
          <section className={cardClass}>
            <h2 className="text-lg font-semibold text-gray-900">Setup status</h2>
            <p className="mt-2 text-sm text-gray-600">
              State: <span className="font-medium">{dash.onboarding.state}</span> · Employees:{' '}
              {dash.onboarding.employee_count} · Mailboxes connected: {dash.onboarding.mailboxes_connected}
            </p>
          </section>
        ) : null}

        {!isCeo ? (
          <>
            <section className={cardClass}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-gray-900">Needs Attention</h2>
                  {isHead ? (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                      Your dept
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => document.getElementById('conversations')?.scrollIntoView({ behavior: 'smooth' })}
                  className="text-sm font-medium text-gray-500 transition-all duration-200 hover:text-gray-900"
                >
                  View all
                </button>
              </div>
              {!dash?.needs_attention.length ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <span className="text-xl">✅</span>
                  <p className="text-sm text-gray-500">No issues detected 🎉</p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {dash.needs_attention.map((c) => (
                    <li key={c.conversation_id}>
                      <button type="button" onClick={() => setModal(c)} className="grid w-full grid-cols-1 gap-3 px-2 py-3 text-left transition-all duration-200 hover:rounded-lg hover:bg-gray-50 md:grid-cols-[1.8fr_1fr_1fr_1fr]">
                        <div>
                          <p className="font-medium text-gray-900">{c.client_email ?? 'Unknown client'}</p>
                          <p className="text-sm text-gray-500">{c.reason || c.short_reason}</p>
                        </div>
                        <div className="text-sm text-gray-600">{c.follow_up_status}</div>
                        <div>
                          <Badge tone={c.priority === 'HIGH' ? 'high' : c.priority === 'MEDIUM' ? 'medium' : 'low'}>{c.priority}</Badge>
                        </div>
                        <div className="text-sm text-gray-600">{Number(c.delay_hours).toFixed(1)}h</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {!isEmployee ? (
          <section className={cardClass}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-900">
                  {isHead ? 'Team list' : 'Team mailboxes'}
                </h2>
                {isHead ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    Your dept
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-gray-500">{teamMailboxes.length} in list</span>
                <Link
                  href="/employees"
                  className="text-sm font-medium text-amber-800 underline-offset-2 hover:text-amber-950 hover:underline"
                >
                  {isHead ? 'Open full team page' : 'Employee list'}
                </Link>
              </div>
            </div>
            {isHead && !me.department_id ? (
              <p className="text-sm text-amber-900">
                Your manager profile has no department assigned, so the team list cannot load. Ask your CEO to link your
                account to the correct department.
              </p>
            ) : teamMailboxes.length === 0 ? (
              <p className="text-sm text-gray-500">
                {isHead
                  ? 'No team members in your department yet. Add them from Add team member.'
                  : 'No employees added yet.'}
              </p>
            ) : (
              <ul className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                {teamMailboxes.map((e) => (
                  <li key={e.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{e.name}</p>
                      <p className="truncate text-xs text-gray-500">{e.email} · {e.department_name}</p>
                    </div>
                    <span
                      className={`ml-2 shrink-0 text-xs font-medium ${
                        (e.gmail_status ?? 'EXPIRED') === 'CONNECTED' ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {(e.gmail_status ?? 'EXPIRED') === 'CONNECTED' ? 'Gmail OK' : 'Needs Gmail'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

            <section id="conversations" className={cardClass}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Conversations</h2>
            {isHead ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                Department
              </span>
            ) : null}
          </div>
          <div className="mb-4 flex flex-wrap gap-4">
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 sm:w-auto">
              <option value="">All statuses</option>
              <option value="DONE">Done</option>
              <option value="PENDING">Pending</option>
              <option value="MISSED">Missed</option>
            </select>
            <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 sm:w-auto">
              <option value="">All priorities</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
            {!isEmployee ? (
              <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)} className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 sm:w-auto">
                <option value="">All employees</option>
                {dash?.employee_filter_options.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            ) : null}
          </div>

          {!dash?.conversations.length ? (
            <p className="text-sm text-gray-500">No issues detected 🎉</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Client</th>
                    {!isEmployee ? <th className="px-4 py-3">Employee</th> : null}
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Delay / SLA</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {dash.conversations.map((c) => (
                    <tr key={c.conversation_id} className="transition-all duration-200 hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-800">{c.client_email ?? '—'}</td>
                      {!isEmployee ? <td className="px-4 py-3 text-gray-600">{c.employee_name}</td> : null}
                      <td className="px-4 py-3">
                        <Badge tone={c.follow_up_status === 'MISSED' ? 'missed' : c.follow_up_status === 'PENDING' ? 'pending' : 'done'}>{c.follow_up_status}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={c.priority === 'HIGH' ? 'high' : c.priority === 'MEDIUM' ? 'medium' : 'low'}>{c.priority}</Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{Number(c.delay_hours).toFixed(1)}h / {Number(c.sla_hours).toFixed(0)}h</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button type="button" onClick={() => window.open(c.open_gmail_link, '_blank', 'noopener,noreferrer')} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm">Open</button>
                          <button type="button" onClick={() => void markDone(c.conversation_id)} disabled={actionLoading} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white transition-all duration-200 hover:bg-blue-700 hover:shadow-md">Done</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
            </section>
          </>
        ) : null}

        {!isEmployee ? (
          <section className={cardClass}>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-900">AI Insights</h2>
                {isCeo ? (
                  <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700">
                    Executive summary
                  </span>
                ) : null}
                {isHead ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    Team
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={() => void openFullAiReport()}
                  disabled={fullReportLoading}
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {fullReportLoading ? 'Loading…' : 'View full report'}
                </button>
                <button
                  type="button"
                  onClick={() => void generateReportNow()}
                  disabled={reportLoading}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reportLoading ? 'Generating...' : 'Generate report now'}
                </button>
                <div className="text-right text-xs">
                  {aiUpdatedMins ? <span className="block text-gray-500">Updated {aiUpdatedMins}</span> : null}
                  {reportCountdownLabel ? (
                    <span className="block font-medium text-blue-600">Next AI report in {reportCountdownLabel}</span>
                  ) : null}
                </div>
              </div>
            </div>
            {dash?.ai_insights.lines.length ? (
              <ul className="list-disc space-y-2 pl-5 text-sm text-gray-600">
                {dash.ai_insights.lines.slice(0, 6).map((line, i) => <li key={i}>{line}</li>)}
                {dash.ai_insights.lines.length > 6 ? (
                  <li className="list-none pl-0 text-gray-400">
                    <button type="button" onClick={() => void openFullAiReport()} className="text-sm font-medium text-blue-600 hover:underline">
                      Show all in full report →
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Insights will appear automatically.</p>
            )}
          </section>
        ) : null}

      </AppShell>

      {!isEmployee && fullReportOpen && fullReport ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-report-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 sm:p-6"
          onClick={() => {
            setFullReportOpen(false);
            setFullReport(null);
          }}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-100 bg-gray-50 px-6 py-4">
              <div>
                <h2 id="ai-report-title" className="text-xl font-semibold text-gray-900">
                  AI follow-up report
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  {fullReport.generated_at
                    ? new Date(fullReport.generated_at).toLocaleString()
                    : 'No timestamp'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFullReportOpen(false);
                  setFullReport(null);
                }}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <section className="mb-8">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Key issues</h3>
                {(fullReport.key_issues ?? []).length ? (
                  <ul className="list-disc space-y-2 pl-5 text-base leading-relaxed text-gray-800">
                    {fullReport.key_issues.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">No key issues listed.</p>
                )}
              </section>
              <section className="mb-8">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Employee insights</h3>
                {(fullReport.employee_insights ?? []).length ? (
                  <ul className="list-disc space-y-2 pl-5 text-base leading-relaxed text-gray-800">
                    {fullReport.employee_insights.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">No employee insights listed.</p>
                )}
              </section>
              <section className="mb-8">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Patterns</h3>
                {(fullReport.patterns ?? []).length ? (
                  <ul className="list-disc space-y-2 pl-5 text-base leading-relaxed text-gray-800">
                    {fullReport.patterns.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">No patterns listed.</p>
                )}
              </section>
              <section className="rounded-xl border border-blue-100 bg-blue-50/80 p-4">
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-blue-800">Recommendation</h3>
                <p className="text-base leading-relaxed text-blue-950">
                  {fullReport.recommendation?.trim() || 'No recommendation in this report.'}
                </p>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {modal ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">{modal.client_email ?? 'Conversation'}</h3>
            <p className="mt-1 text-sm text-gray-500">{modal.employee_name}</p>
            <p className="mt-3 text-sm text-gray-700">{modal.reason || modal.short_reason}</p>
            {modal.summary ? <p className="mt-3 text-sm text-gray-600">{modal.summary}</p> : null}
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => window.open(modal.open_gmail_link, '_blank', 'noopener,noreferrer')} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm">Open in Gmail</button>
              <button type="button" onClick={() => void markDone(modal.conversation_id)} disabled={actionLoading} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white transition-all duration-200 hover:bg-blue-700 hover:shadow-md">Mark Done</button>
              <button type="button" onClick={() => setModal(null)} className="ml-auto rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm">Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
