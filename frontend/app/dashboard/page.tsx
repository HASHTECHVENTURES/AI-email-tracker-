'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch, readApiErrorMessage, tryRecoverFromUnauthorized } from '@/lib/api';
import { useAuth, type AuthMe as Me } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import type { CeoDeptDirectoryRow } from '@/components/CeoDashboardScopePanel';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { TimeGreeting } from '@/components/TimeGreeting';
import { Badge } from '@/components/Badge';
import { conversationReadPath } from '@/lib/conversation-read';
import { isDepartmentManagerRole } from '@/lib/roles';
import { useActAsEmployeeMailboxView } from '@/lib/use-act-as-employee-mailbox';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { ReassignModal } from '@/components/ReassignModal';
import { TeamAlertReplyModal } from '@/components/TeamAlertReplyModal';

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
  updated_at?: string;
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

type CeoEmployeeMailboxRollup = {
  employee_id: string;
  employee_name: string;
  department_name: string | null;
  total_threads: number;
  missed: number;
  pending: number;
  done: number;
  need_attention_count: number;
};

type DashboardPayload = {
  needs_attention: ConversationRow[];
  ai_insights: {
    lines: string[];
    key_issues: string[];
    employee_insights: string[];
    patterns: string[];
    recommendation: string | null;
    last_updated_at: string | null;
  };
  conversations: ConversationRow[];
  onboarding: {
    show: boolean;
    employee_count: number;
    mailboxes_connected: number;
    state: 'NO_EMPLOYEES' | 'GMAIL_PENDING' | 'WAITING_FOR_SYNC' | 'READY';
    employee_added: boolean;
    waiting_for_sync: boolean;
  };
  employee_filter_options: { id: string; name: string; department_name?: string | null; is_manager?: boolean }[];
  my_followups?: { missed: number; pending: number; done: number };
  ceo_department_rollups?: CeoDepartmentRollup[];
  ceo_employee_mailbox_rollups?: CeoEmployeeMailboxRollup[];
  historical_search_runs?: {
    id: string;
    employee_id: string;
    mailbox_name: string;
    window_start: string;
    window_end: string;
    created_at: string;
    report_summary: string;
    conversation_count: number;
    stats: Record<string, unknown>;
  }[];
};

type TeamAlertItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  from_user_id?: string;
  from_manager_name: string | null;
  from_manager_email: string | null;
  in_reply_to?: string | null;
  is_own_message?: boolean;
};

function localDayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isResolvedToday(row: ConversationRow): boolean {
  if (row.follow_up_status !== 'DONE') return false;
  const t = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return t >= localDayStartMs();
}

function needsAttentionPredicate(c: ConversationRow): boolean {
  return c.follow_up_status === 'MISSED' || (c.priority === 'HIGH' && c.follow_up_status !== 'DONE');
}

type TeamHealth = 'at_risk' | 'watch' | 'steady';

function teamHealth(row: { attention: number; missed: number; pending: number }): TeamHealth {
  if (row.missed > 0) return 'at_risk';
  if (row.attention > 0) return 'watch';
  if (row.pending > 0) return 'watch';
  return 'steady';
}

function CeoDelayMeter({ delay, sla }: { delay: number; sla: number }) {
  const ratio = sla > 0 ? Math.min(1, delay / sla) : 0;
  const over = delay > sla;
  const pct = Math.round(ratio * 100);
  const hot = !over && sla > 0 && delay / sla > 0.85;
  return (
    <div className="min-w-[132px] max-w-[200px]">
      <div className="flex justify-between gap-2 text-[11px] font-semibold tabular-nums">
        <span className={over ? 'text-red-600' : hot ? 'text-amber-700' : 'text-slate-800'}>
          {delay.toFixed(1)}h
        </span>
        <span className="font-normal text-slate-400">/ {sla.toFixed(0)}h</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${over ? 'bg-red-500' : hot ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function TeamHealthDot({ health }: { health: TeamHealth }) {
  const meta = {
    at_risk: { cls: 'bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.22)]', label: 'At risk — missed SLAs' },
    watch: { cls: 'bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.28)]', label: 'Watch — queue or attention items' },
    steady: { cls: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]', label: 'Steady' },
  }[health];
  return (
    <span
      className={`inline-block h-3 w-3 shrink-0 rounded-full ${meta.cls}`}
      title={meta.label}
      role="img"
      aria-label={meta.label}
    />
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();
  // Managers can act as Employees if they selected "Employee" at login.
  const canActAsMailbox =
    !!me &&
    isDepartmentManagerRole(me.role) &&
    !!(me.linked_employee_id?.trim());
  const actAsMailboxView = useActAsEmployeeMailboxView(canActAsMailbox);
  const [error, setError] = useState<string | null>(null);
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [syncCountdownSec, setSyncCountdownSec] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  /** CEO: multi-select departments; empty = whole company. */
  const [filterDepartmentIds, setFilterDepartmentIds] = useState<string[]>([]);
  const [ceoDeptOptions, setCeoDeptOptions] = useState<CeoDeptDirectoryRow[]>([]);
  /** CEO: multi-select mailboxes; empty = all people in current dept / company slice. */
  const [ceoEmployeeIds, setCeoEmployeeIds] = useState<string[]>([]);
  const ceoScopeRestoredRef = useRef(false);
  const [reassignTarget, setReassignTarget] = useState<ConversationRow | null>(null);
  /** Per-row resolve: a single boolean disabled every Resolve on the page. */
  const [resolvingConversationId, setResolvingConversationId] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [deletingTeamAlertId, setDeletingTeamAlertId] = useState<string | null>(null);
  const [teamAlerts, setTeamAlerts] = useState<{ items: TeamAlertItem[]; unread_count: number } | null>(null);
  const [replyModalParent, setReplyModalParent] = useState<TeamAlertItem | null>(null);
  const [authFlash, setAuthFlash] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem('ai_et_auth_notice_v1');
      if (!raw) return;
      sessionStorage.removeItem('ai_et_auth_notice_v1');
      const parsed = JSON.parse(raw) as { message?: string };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        setAuthFlash(parsed.message.trim());
      }
    } catch {
      sessionStorage.removeItem('ai_et_auth_notice_v1');
    }
  }, []);

  const authFlashBanner =
    authFlash ? (
      <div
        role="status"
        className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm"
      >
        <p className="min-w-0 flex-1 leading-relaxed">{authFlash}</p>
        <button
          type="button"
          onClick={() => setAuthFlash(null)}
          className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
        >
          Dismiss
        </button>
      </div>
    ) : null;

  const buildDashboardPath = useCallback(() => {
    const qs = new URLSearchParams();
    if (filterStatus) qs.set('status', filterStatus);
    if (filterPriority) qs.set('priority', filterPriority);
    if (me?.role === 'CEO') {
      const deptQs = [...filterDepartmentIds].sort();
      if (deptQs.length > 0) qs.set('department_ids', deptQs.join(','));
      const ids = [...ceoEmployeeIds].sort();
      if (ids.length > 0) qs.set('employee_ids', ids.join(','));
    } else if (filterEmployee && me?.role !== 'EMPLOYEE' && !actAsMailboxView) {
      qs.set('employee_id', filterEmployee);
    }
    const q = qs.toString();
    return `/dashboard${q ? `?${q}` : ''}`;
  }, [filterStatus, filterPriority, filterEmployee, filterDepartmentIds, ceoEmployeeIds, me?.role, actAsMailboxView]);

  const refresh = useCallback(async () => {
    if (!token) return;

    const alertResPromise =
      me?.role === 'EMPLOYEE' || canActAsMailbox
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
      setError(await readApiErrorMessage(dRes, 'Could not load your dashboard.'));
    }
    if (sRes.ok) {
      const nextStatus = (await sRes.json()) as SystemStatus;
      setStatus(nextStatus);
      setSyncCountdownSec(
        nextStatus.email_crawl_enabled === false ? null : (nextStatus.seconds_until_next_ingestion ?? null),
      );
    }
    if (me?.role === 'EMPLOYEE' || canActAsMailbox) {
      if (taRes.ok) {
        setTeamAlerts((await taRes.json()) as { items: TeamAlertItem[]; unread_count: number });
      } else {
        if (await tryRecoverFromUnauthorized(taRes, ctxSignOut)) return;
        setTeamAlerts({ items: [], unread_count: 0 });
      }
    } else {
      setTeamAlerts(null);
    }
  }, [buildDashboardPath, canActAsMailbox, ctxSignOut, me?.role, token]);

  useRefetchOnFocus(() => void refresh(), Boolean(me && token));

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
        setError(await readApiErrorMessage(statusRes, 'Could not verify your session.'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, me, token, router]);

  useEffect(() => {
    if (!me || !token) return;
    const id = window.setTimeout(() => void refresh(), 180);
    return () => clearTimeout(id);
  }, [
    me,
    token,
    refresh,
    filterStatus,
    filterPriority,
    filterEmployee,
    filterDepartmentIds,
    ceoEmployeeIds,
    actAsMailboxView,
  ]);

  useEffect(() => {
    if (me?.role !== 'CEO') {
      ceoScopeRestoredRef.current = false;
      return;
    }
    if (typeof window === 'undefined' || ceoScopeRestoredRef.current) return;
    ceoScopeRestoredRef.current = true;
    try {
      const raw = sessionStorage.getItem('ai_et_ceo_dashboard_scope_v1');
      if (raw) {
        const j = JSON.parse(raw) as {
          departmentId?: unknown;
          departmentIds?: unknown;
          employeeIds?: unknown;
        };
        let deptIds: string[] = [];
        if (Array.isArray(j.departmentIds)) {
          deptIds = [
            ...new Set(j.departmentIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)),
          ];
        } else if (typeof j.departmentId === 'string' && j.departmentId.trim()) {
          deptIds = [j.departmentId.trim()];
        }
        let empIds: string[] = [];
        if (Array.isArray(j.employeeIds)) {
          empIds = [
            ...new Set(j.employeeIds.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)),
          ];
        }
        setFilterDepartmentIds(deptIds);
        setCeoEmployeeIds(empIds);
      }
    } catch {
      /* ignore */
    }
  }, [me?.role]);

  useEffect(() => {
    if (me?.role !== 'CEO' || typeof window === 'undefined') return;
    try {
      sessionStorage.setItem(
        'ai_et_ceo_dashboard_scope_v1',
        JSON.stringify({
          departmentIds: filterDepartmentIds,
          employeeIds: ceoEmployeeIds,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [me?.role, filterDepartmentIds, ceoEmployeeIds]);

  useEffect(() => {
    if (me?.role !== 'CEO' || !dash?.employee_filter_options?.length) return;
    const allowed = new Set(dash.employee_filter_options.map((e) => e.id));
    const linked = me?.linked_employee_id?.trim();
    if (linked) allowed.add(linked);
    setCeoEmployeeIds((prev) => {
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [dash?.employee_filter_options, me?.role, me?.linked_employee_id]);

  useEffect(() => {
    if (me?.role !== 'CEO' || ceoDeptOptions.length === 0) return;
    const allowed = new Set(ceoDeptOptions.map((d) => d.id));
    setFilterDepartmentIds((prev) => {
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [ceoDeptOptions, me?.role]);

  useEffect(() => {
    if (!token || me?.role !== 'CEO') {
      setCeoDeptOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await apiFetch('/departments', token);
      if (!r.ok || cancelled) return;
      const rows = (await r.json()) as CeoDeptDirectoryRow[];
      setCeoDeptOptions(Array.isArray(rows) ? rows : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, me?.role]);

  useEffect(() => {
    if (me?.role !== 'CEO') setFilterDepartmentIds([]);
  }, [me?.role]);

  useEffect(() => {
    if (!me || !token) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, 10_000);
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
    setResolvingConversationId(conversationId);
    try {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/mark-done`, token, {
        method: 'POST',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not update');
        return;
      }
      await refresh();
    } finally {
      setResolvingConversationId(null);
    }
  }

  async function deleteThread(conversationId: string, hint?: string | null) {
    if (!token) return;
    const label = hint?.trim() ? ` — ${hint.trim()}` : '';
    if (
      !window.confirm(
        `Permanently delete this thread${label}? Synced messages for this conversation will be removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingConversationId(conversationId);
    try {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}`, token, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not delete this thread.'));
        return;
      }
      await refresh();
    } finally {
      setDeletingConversationId(null);
    }
  }

  async function deleteTeamAlert(alertId: string) {
    if (!token) return;
    if (
      !window.confirm(
        'Delete this manager message and any replies? This cannot be undone.',
      )
    ) {
      return;
    }
    setDeletingTeamAlertId(alertId);
    try {
      const res = await apiFetch(`/team-alerts/${encodeURIComponent(alertId)}`, token, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not delete this message.'));
        return;
      }
      await refresh();
    } finally {
      setDeletingTeamAlertId(null);
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
    const needsAttentionTotal = conv.filter(needsAttentionPredicate).length;
    const resolvedToday = conv.filter(isResolvedToday).length;
    return {
      needsAttention: needsAttentionTotal,
      pending: conv.filter((c) => c.follow_up_status === 'PENDING').length,
      missed: conv.filter((c) => c.follow_up_status === 'MISSED').length,
      resolvedToday,
      resolvedAll: conv.filter((c) => c.follow_up_status === 'DONE').length,
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

  const ceoActionRows = useMemo(() => {
    const rows = dash?.needs_attention ?? [];
    return [...rows].sort((a, b) => Number(b.delay_hours) - Number(a.delay_hours));
  }, [dash?.needs_attention]);

  const shellRoleForLoading = me?.role ?? shellRoleHint ?? 'EMPLOYEE';

  if (!me || authLoading) {
    return (
      <AppShell
        role={shellRoleForLoading}
        title="Dashboard"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  const isEmployee = me.role === 'EMPLOYEE' || actAsMailboxView;
  const isHead = isDepartmentManagerRole(me.role);
  /** Manager-only dashboard chrome (hide when HEAD is in mailbox / employee view). */
  const managerDashboardChrome = isHead && !actAsMailboxView;
  const isCeo = !isEmployee && !isHead;
  const dashboardSubtitle = isEmployee
    ? 'Your follow-ups and SLA.'
    : isHead
      ? 'What needs you right now — then how your team is trending.'
      : 'Attention, team load, and AI context — executive view.';

  /** Live next-sync countdown: useful for managers/employees; hidden on CEO overview. */
  const nextSyncLabelForRole = isCeo ? null : syncCountdownLabel;

  const titleEyebrow = <TimeGreeting fullName={me.full_name} email={me.email} />;

  if (!dash) {
    return (
        <AppShell
          role={me.role}
          companyName={me.company_name ?? null}
          userDisplayName={me.full_name?.trim() || me.email}
          titleEyebrow={titleEyebrow}
          title={isEmployee ? 'My follow-ups' : isHead ? 'Workspace' : 'Command center'}
          subtitle={dashboardSubtitle}
          lastSyncLabel={lastSyncLabel}
          nextIngestionCountdownLabel={nextSyncLabelForRole}
          isActive={status?.is_active}
          aiBriefingsEnabled={status == null ? undefined : status.ai_status}
          mailboxCrawlEnabled={status == null ? undefined : status.email_crawl_enabled !== false}
          onRefresh={() => void refresh()}
          onSignOut={() => void ctxSignOut()}
        >
        {authFlashBanner}
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
            <p className="mt-3 text-xs text-red-700/90">Please retry in a moment. If this keeps happening, contact your admin.</p>
          </div>
        ) : (
          <PortalPageLoader variant="embedded" />
        )}
        </AppShell>
    );
  }

  const attentionCount = kpi.needsAttention;
  const pendingCount = kpi.pending;
  const missedCount = kpi.missed;
  const resolvedTodayCount = kpi.resolvedToday;
  const conversations = dash.conversations ?? [];
  const needsAttentionRows = dash.needs_attention ?? [];
  const aiKeyIssues = dash.ai_insights.key_issues ?? [];
  const aiPatterns = dash.ai_insights.patterns ?? [];
  const aiPeopleLines = dash.ai_insights.employee_insights ?? [];
  const aiRecommendation = dash.ai_insights.recommendation?.trim() || null;
  const aiLegacyLines = dash.ai_insights.lines ?? [];
  const hasAiInsights =
    aiKeyIssues.length > 0 ||
    aiPatterns.length > 0 ||
    aiPeopleLines.length > 0 ||
    Boolean(aiRecommendation) ||
    aiLegacyLines.length > 0;

  const cardClass =
    'rounded-2xl border border-slate-200/60 bg-surface-card p-6 shadow-card';

  const historicalRuns = dash.historical_search_runs ?? [];
  const historicalSearchCard =
    historicalRuns.length > 0 ? (
      <section className={cardClass}>
        <div className="mb-5 border-b border-slate-100 pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">My Email</p>
          <h2 className="mt-1 text-lg font-bold text-slate-950">Historical search log</h2>
          <p className="mt-1 text-sm text-slate-600">
            Saved Gmail windows — bar length shows how many threads were captured in each run (relative to the
            largest in this list).
          </p>
        </div>
        {(() => {
          const maxThreads = Math.max(1, ...historicalRuns.map((r) => Number(r.conversation_count ?? 0)));
          return (
            <div className="grid gap-3 sm:grid-cols-2">
              {historicalRuns.map((r) => {
                const n = Number(r.conversation_count ?? 0);
                const barPct = Math.round((n / maxThreads) * 100);
                return (
                  <Link
                    key={r.id}
                    href={`/my-email?historicalRun=${encodeURIComponent(r.id)}`}
                    className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/90 p-4 shadow-sm transition hover:border-brand-300 hover:shadow-md"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-500 to-violet-600 opacity-90"
                      aria-hidden
                    />
                    <div className="pl-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mailbox</p>
                      <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-slate-900">{r.mailbox_name}</p>
                      <p className="mt-2 text-[11px] leading-snug text-slate-500">{r.report_summary}</p>
                      <div className="mt-3 flex items-end justify-between gap-2">
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-slate-950">{n}</p>
                          <p className="text-[10px] font-medium uppercase text-slate-400">threads</p>
                        </div>
                        <div className="text-right text-[10px] text-slate-400">
                          Saved
                          <br />
                          <span className="tabular-nums text-slate-600">
                            {new Date(r.created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200/80">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-[width] group-hover:from-brand-600 group-hover:to-violet-600"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })()}
        <Link
          href="/my-email"
          className="mt-5 inline-flex text-sm font-semibold text-brand-600 hover:text-brand-800"
        >
          Open My Email →
        </Link>
      </section>
    ) : null;

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
        {!isEmployee && !isCeo ? (
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
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => router.push(conversationReadPath(c.conversation_id, '/dashboard'))}
                        className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Read mail
                      </button>
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
                        disabled={
                          resolvingConversationId === c.conversation_id ||
                          deletingConversationId === c.conversation_id
                        }
                        className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                      >
                        {resolvingConversationId === c.conversation_id ? 'Resolving…' : 'Resolve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteThread(c.conversation_id, c.client_email)}
                        disabled={
                          resolvingConversationId === c.conversation_id ||
                          deletingConversationId === c.conversation_id
                        }
                        className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        {deletingConversationId === c.conversation_id ? 'Deleting…' : 'Delete'}
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
        userDisplayName={me.full_name?.trim() || me.email}
        titleEyebrow={titleEyebrow}
        title={isEmployee ? 'My follow-ups' : isHead ? 'Workspace' : 'Command center'}
        subtitle={dashboardSubtitle}
        lastSyncLabel={lastSyncLabel}
        nextIngestionCountdownLabel={nextSyncLabelForRole}
        isActive={status?.is_active}
        aiBriefingsEnabled={status == null ? undefined : status.ai_status}
        mailboxCrawlEnabled={status == null ? undefined : status.email_crawl_enabled !== false}
        onRefresh={() => void refresh()}
        onSignOut={() => void ctxSignOut()}
      >
        {authFlashBanner}
        {isCeo ? (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-4" aria-label="Executive KPIs">
              {(
                [
                  {
                    label: 'Needs attention',
                    value: attentionCount,
                    accent: 'from-violet-500 to-brand-600',
                  },
                  { label: 'Pending', value: pendingCount, accent: 'from-amber-400 to-orange-500' },
                  { label: 'Missed SLA', value: missedCount, accent: 'from-red-500 to-rose-600' },
                  { label: 'Resolved today', value: resolvedTodayCount, accent: 'from-emerald-400 to-teal-500' },
                ] as const
              ).map((k) => (
                <div
                  key={k.label}
                  className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-md shadow-slate-900/[0.06] ring-1 ring-slate-900/[0.04]"
                >
                  <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${k.accent}`} aria-hidden />
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{k.label}</p>
                  <p className="mt-3 text-3xl font-bold tabular-nums tracking-tight text-slate-950 sm:text-4xl">{k.value}</p>
                </div>
              ))}
            </section>

            {(dash.ceo_employee_mailbox_rollups?.length ?? 0) > 0 ? (
              <section className={cardClass}>
                <div className="mb-5 border-b border-slate-100 pb-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">People in scope</p>
                  <h2 className="mt-1 text-xl font-bold text-slate-950">Mailbox load (employees)</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Thread volume and status for each individual mailbox in your selected scope.
                  </p>
                </div>
                <div className="space-y-4">
                  {(() => {
                    const rollups = dash.ceo_employee_mailbox_rollups ?? [];
                    const maxAttn = Math.max(1, ...rollups.map((r) => r.need_attention_count));
                    return rollups.map((r) => {
                      const attnPct = Math.min(100, Math.round((r.need_attention_count / maxAttn) * 100));
                      const total = Math.max(1, r.total_threads);
                      const donePct = Math.round((r.done / total) * 100);
                      const pendPct = Math.round((r.pending / total) * 100);
                      const missedPct = Math.round((r.missed / total) * 100);
                      return (
                        <div
                          key={r.employee_id}
                          className="rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50/40 to-white px-4 py-3"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-800/90">Mailbox</p>
                              <p className="font-semibold text-slate-900">{r.employee_name}</p>
                              <p className="text-xs text-slate-500">
                                {r.department_name?.trim() ? r.department_name.trim() : 'Department not set'}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-3 text-xs tabular-nums text-slate-600">
                              <span title="Needs attention">
                                <span className="font-semibold text-violet-700">{r.need_attention_count}</span> attn
                              </span>
                              <span>
                                <span className="font-semibold text-red-600">{r.missed}</span> missed
                              </span>
                              <span>
                                <span className="font-semibold text-amber-700">{r.pending}</span> pend
                              </span>
                              <span>
                                <span className="font-semibold text-emerald-700">{r.done}</span> done
                              </span>
                            </div>
                          </div>
                          <div className="mt-3 space-y-1.5">
                            <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-brand-600 transition-[width] duration-300"
                                style={{ width: `${attnPct}%` }}
                                title={`Need attention: ${r.need_attention_count}`}
                              />
                            </div>
                            <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200/60">
                              <div className="bg-emerald-500" style={{ width: `${donePct}%` }} title={`Done ${r.done}`} />
                              <div className="bg-amber-400" style={{ width: `${pendPct}%` }} title={`Pending ${r.pending}`} />
                              <div className="bg-red-500" style={{ width: `${missedPct}%` }} title={`Missed ${r.missed}`} />
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </section>
            ) : null}

            {(dash.ceo_department_rollups?.length ?? 0) > 0 ? (
              <section className={cardClass}>
                <div className="mb-5 border-b border-slate-100 pb-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Org load</p>
                  <h2 className="mt-1 text-xl font-bold text-slate-950">
                    {filterDepartmentIds.length > 0 ? 'Department pressure (filtered)' : 'Department pressure'}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Need-attention volume by department — bar length is relative to the busiest team in view.
                  </p>
                </div>
                <div className="space-y-4">
                  {(() => {
                    const rollups = dash.ceo_department_rollups ?? [];
                    const maxAttn = Math.max(1, ...rollups.map((r) => r.need_attention_count));
                    return rollups.map((r) => {
                      const attnPct = Math.min(100, Math.round((r.need_attention_count / maxAttn) * 100));
                      const total = Math.max(1, r.total_threads);
                      const donePct = Math.round((r.done / total) * 100);
                      const pendPct = Math.round((r.pending / total) * 100);
                      const missedPct = Math.round((r.missed / total) * 100);
                      return (
                        <div key={r.department_id} className="rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Team</p>
                              <p className="font-semibold text-slate-900">{r.department_name}</p>
                              <p className="text-xs text-slate-500">
                                {r.manager_name?.trim()
                                  ? `Team lead: ${r.manager_name.trim()}`
                                  : r.manager_email
                                    ? `Team lead: ${r.manager_email}`
                                    : 'No team lead assigned'}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-3 text-xs tabular-nums text-slate-600">
                              <span title="Needs attention">
                                <span className="font-semibold text-violet-700">{r.need_attention_count}</span> attn
                              </span>
                              <span>
                                <span className="font-semibold text-red-600">{r.missed}</span> missed
                              </span>
                              <span>
                                <span className="font-semibold text-amber-700">{r.pending}</span> pend
                              </span>
                              <span>
                                <span className="font-semibold text-emerald-700">{r.done}</span> done
                              </span>
                            </div>
                          </div>
                          <div className="mt-3 space-y-1.5">
                            <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-violet-600 to-brand-600 transition-[width] duration-300"
                                style={{ width: `${attnPct}%` }}
                                title={`Need attention: ${r.need_attention_count}`}
                              />
                            </div>
                            <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200/60">
                              <div className="bg-emerald-500" style={{ width: `${donePct}%` }} title={`Done ${r.done}`} />
                              <div className="bg-amber-400" style={{ width: `${pendPct}%` }} title={`Pending ${r.pending}`} />
                              <div className="bg-red-500" style={{ width: `${missedPct}%` }} title={`Missed ${r.missed}`} />
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </section>
            ) : null}

            {dash.onboarding?.show ? (
              <section className={cardClass}>
                <h2 className="text-sm font-semibold text-slate-900">Setup</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {dash.onboarding?.state ?? '—'} · {dash.onboarding?.employee_count ?? 0} people ·{' '}
                  {dash.onboarding?.mailboxes_connected ?? 0} mailboxes
                </p>
              </section>
            ) : null}

            <section className="rounded-2xl border-2 border-slate-900/10 bg-white p-6 shadow-lg shadow-slate-900/[0.08] ring-1 ring-slate-900/[0.05] sm:p-8">
              <header className="mb-8 border-b border-slate-100 pb-6">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-600">Now</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Action required</h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
                  Highest delay first. Missed SLA and high-priority threads are visually emphasized for fast decisions.
                </p>
                {attentionCount > ceoActionRows.length ? (
                  <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950 ring-1 ring-amber-100">
                    Showing {ceoActionRows.length} of {attentionCount} items in this queue — open{' '}
                    <Link href="/departments" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
                      Departments
                    </Link>{' '}
                    or{' '}
                    <Link href="/employees" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
                      Employees
                    </Link>{' '}
                    to go deeper.
                  </p>
                ) : null}
              </header>
              {ceoActionRows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-14 text-center">
                  <p className="text-lg font-semibold text-slate-800">Nothing critical in queue</p>
                  <p className="mt-2 text-sm text-slate-500">No missed SLAs or high-priority open threads right now.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/40">
                  <table className="min-w-[920px] w-full text-sm">
                    <thead className="bg-slate-100/80 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-4 py-3 pl-5">Client</th>
                        <th className="px-4 py-3">Owner</th>
                        <th className="px-4 py-3">Delay vs SLA</th>
                        <th className="px-4 py-3">Priority</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 pr-5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/80">
                      {ceoActionRows.map((c) => {
                        const delay = Number(c.delay_hours);
                        const sla = Number(c.sla_hours);
                        const leftAccent =
                          c.follow_up_status === 'MISSED'
                            ? 'border-l-red-500 bg-red-50/20'
                            : c.priority === 'HIGH'
                              ? 'border-l-violet-600 bg-violet-50/15'
                              : 'border-l-slate-200 bg-white';
                        return (
                          <tr
                            key={c.conversation_id}
                            className={`border-l-[5px] transition-colors hover:bg-white/90 ${leftAccent}`}
                          >
                            <td className="px-4 py-4 pl-5 align-top">
                              <button
                                type="button"
                                onClick={() => router.push(conversationReadPath(c.conversation_id, '/dashboard'))}
                                className="text-left font-semibold text-slate-950 hover:text-brand-600"
                              >
                                {c.client_email ?? '—'}
                              </button>
                            </td>
                            <td className="px-4 py-4 align-top text-slate-700">{c.employee_name}</td>
                            <td className="px-4 py-4 align-top">
                              <CeoDelayMeter delay={delay} sla={sla} />
                            </td>
                            <td className="px-4 py-4 align-top">
                              <Badge tone={c.priority === 'HIGH' ? 'high' : c.priority === 'MEDIUM' ? 'medium' : 'low'}>
                                {c.priority}
                              </Badge>
                            </td>
                            <td className="px-4 py-4 align-top">
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
                            <td className="px-4 py-4 pr-5 text-right align-top">
                              <div className="flex flex-wrap justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => void deleteThread(c.conversation_id, c.client_email)}
                                  disabled={
                                    resolvingConversationId === c.conversation_id ||
                                    deletingConversationId === c.conversation_id
                                  }
                                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50"
                                >
                                  {deletingConversationId === c.conversation_id ? 'Deleting…' : 'Delete'}
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

            <section className={cardClass}>
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Team</p>
                  <h2 className="mt-1 text-xl font-bold text-slate-950">Performance by teammate</h2>
                  <p className="mt-1 text-sm text-slate-600">Status dot reflects risk: missed SLAs, attention queue, or steady.</p>
                </div>
                <Link href="/employees" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
                  Manage team →
                </Link>
              </div>
              {employeePerformance.length === 0 ? (
                <p className="text-sm text-slate-500">No teammate activity in scope yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="min-w-[560px] w-full text-sm">
                    <thead className="bg-slate-50/90 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3 pl-5">Status</th>
                        <th className="px-4 py-3">Teammate</th>
                        <th className="px-4 py-3">Attention</th>
                        <th className="px-4 py-3">Missed</th>
                        <th className="px-4 py-3">Pending</th>
                        <th className="px-4 py-3 pr-5">Resolved</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {employeePerformance.map((row) => {
                        const h = teamHealth(row);
                        return (
                          <tr key={row.employee_id} className="hover:bg-slate-50/60">
                            <td className="px-4 py-3 pl-5">
                              <TeamHealthDot health={h} />
                            </td>
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
                            <td className="px-4 py-3 pr-5 tabular-nums font-medium text-emerald-600">{row.resolved}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className={`${cardClass} border-slate-300/80 bg-gradient-to-b from-slate-50/80 to-white`}>
              <div className="mb-6 border-b border-slate-200/80 pb-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-600">AI insights</p>
                <h2 className="mt-1 text-xl font-bold text-slate-950">Executive briefing signals</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Pulled from your latest saved executive report. Update via{' '}
                  <Link href="/ai-reports" className="font-semibold text-brand-600 hover:text-brand-700">
                    Reports
                  </Link>
                  .
                </p>
                {dash.ai_insights.last_updated_at ? (
                  <p className="mt-2 text-xs text-slate-400">
                    Last model run: {new Date(dash.ai_insights.last_updated_at).toLocaleString()}
                  </p>
                ) : null}
              </div>
              {!hasAiInsights ? (
                <p className="text-sm text-slate-500">
                  No briefing on file yet. Turn AI on in Settings and generate a report, or run one from Reports.
                </p>
              ) : (
                <div className="grid gap-8 lg:grid-cols-2">
                  <div className="space-y-4">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Key issues and risks</h3>
                    {aiKeyIssues.length > 0 ? (
                      <ul className="space-y-3">
                        {aiKeyIssues.map((line, i) => (
                          <li
                            key={`ki-${i}`}
                            className="flex gap-3 rounded-xl border border-red-100 bg-red-50/40 px-4 py-3 text-sm leading-relaxed text-slate-800"
                          >
                            <span className="mt-0.5 font-mono text-xs font-bold text-red-500">{i + 1}</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    ) : aiLegacyLines.length > 0 ? (
                      <ul className="space-y-2 text-sm text-slate-700">
                        {aiLegacyLines.slice(0, 6).map((line, i) => (
                          <li key={`leg-${i}`} className="flex gap-2">
                            <span className="text-slate-300">·</span>
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">No key issues listed.</p>
                    )}
                    {aiPatterns.length > 0 ? (
                      <div className="pt-2">
                        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Patterns</h4>
                        <ul className="space-y-2 text-sm text-slate-700">
                          {aiPatterns.map((line, i) => (
                            <li key={`pat-${i}`} className="rounded-lg bg-slate-100/80 px-3 py-2">
                              {line}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {aiPeopleLines.length > 0 ? (
                      <div className="pt-2">
                        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">People and teams</h4>
                        <ul className="space-y-2 text-sm text-slate-700">
                          {aiPeopleLines.map((line, i) => (
                            <li key={`peo-${i}`} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                              {line}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Recommendation</h3>
                    {aiRecommendation ? (
                      <p className="mt-3 rounded-2xl border border-violet-200 bg-violet-50/60 p-5 text-base font-medium leading-relaxed text-slate-900">
                        {aiRecommendation}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-slate-500">No recommendation in the latest briefing.</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          <>
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
                  { label: 'Resolved today', value: resolvedTodayCount, bar: 'from-emerald-400 to-teal-600' },
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

            {historicalSearchCard}

        {(isEmployee || canActAsMailbox) && teamAlerts?.items?.some((a) => !a.read_at && !a.in_reply_to) ? (
          <div className="space-y-3" role="region" aria-label="Messages from your manager">
            {(teamAlerts.items ?? [])
              .filter((a) => !a.read_at && !a.in_reply_to)
              .map((a) => (
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
                    <button
                      type="button"
                      onClick={() => setReplyModalParent(a)}
                      className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-center text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                    >
                      Reply
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismissTeamAlert(a.id)}
                      disabled={deletingTeamAlertId === a.id}
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteTeamAlert(a.id)}
                      disabled={deletingTeamAlertId === a.id}
                      className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingTeamAlertId === a.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ) : null}

        <section className={cardClass}>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Action required</h2>
              <p className="mt-1 text-sm text-slate-500">Threads that need a reply or decision.</p>
            </div>
            {managerDashboardChrome ? (
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
                          onClick={() => router.push(conversationReadPath(c.conversation_id, '/dashboard'))}
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
                          <button
                            type="button"
                            onClick={() => router.push(conversationReadPath(c.conversation_id, '/dashboard'))}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300"
                          >
                            Read mail
                          </button>
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
                            disabled={
                              resolvingConversationId === c.conversation_id ||
                              deletingConversationId === c.conversation_id
                            }
                            className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
                          >
                            {resolvingConversationId === c.conversation_id ? 'Resolving…' : 'Resolve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteThread(c.conversation_id, c.client_email)}
                            disabled={
                              resolvingConversationId === c.conversation_id ||
                              deletingConversationId === c.conversation_id
                            }
                            className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50"
                          >
                            {deletingConversationId === c.conversation_id ? 'Deleting…' : 'Delete'}
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

        {!isEmployee && !isCeo ? (
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
          {managerDashboardChrome ? (
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

          </>
        )}
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

      {isEmployee && token ? (
        <TeamAlertReplyModal
          open={replyModalParent != null}
          parent={replyModalParent}
          token={token}
          onClose={() => setReplyModalParent(null)}
          onSent={() => void refresh()}
        />
      ) : null}
    </>
  );
}
