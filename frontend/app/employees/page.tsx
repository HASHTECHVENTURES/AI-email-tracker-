'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

type Me = {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  company_name?: string | null;
  role: string;
  department_id: string | null;
};

type Department = {
  id: string;
  name: string;
};

type EmployeeRow = {
  id: string;
  name: string;
  email: string;
  department_id: string;
  department_name: string;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  /** When true, Gmail fetch skips this mailbox (per-employee pause). */
  tracking_paused?: boolean;
  /** When false, Inbox AI + thread enrichment skip this mailbox. */
  ai_enabled?: boolean;
};

type EmployeeMessage = {
  provider_message_id: string;
  subject: string;
  from_email: string;
  sent_at: string;
};

type DashboardConv = {
  employee_id: string;
  follow_up_status: string;
};

/** `<input type="datetime-local" />` values are naive local time — never use `toISOString().slice(0,16)` (UTC). */
function toLocalDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EmployeesPageInner() {
  const PAGE_SIZE = 8;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [dashStats, setDashStats] = useState<Record<string, { pending: number; missed: number }>>({});
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [aiBriefingsOn, setAiBriefingsOn] = useState(true);
  const [mailboxCrawlOn, setMailboxCrawlOn] = useState(true);
  const [slaInputs, setSlaInputs] = useState<Record<string, string>>({});
  const [messagesByEmployee, setMessagesByEmployee] = useState<Record<string, EmployeeMessage[]>>({});
  const [messagesLoadingFor, setMessagesLoadingFor] = useState<string | null>(null);
  const [trackingInputs, setTrackingInputs] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState<'name' | 'department' | 'gmail' | 'last_sync'>('last_sync');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [pauseSavingFor, setPauseSavingFor] = useState<string | null>(null);
  const [slaSavingFor, setSlaSavingFor] = useState<string | null>(null);
  const [trackingSavingFor, setTrackingSavingFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashNotice(message: string) {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 5000);
  }

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addConfirm, setAddConfirm] = useState('');
  const [addDeptId, setAddDeptId] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const isManager = me?.role === 'HEAD' || me?.role === 'MANAGER';
  const isCeo = me?.role === 'CEO';
  const managerDepartmentName =
    isManager && me?.department_id
      ? departments.find((d) => d.id === me.department_id)?.name ?? 'Assigned department'
      : null;

  async function loadLists(token: string) {
    const [empRes, deptRes, sysRes] = await Promise.all([
      apiFetch('/employees', token),
      apiFetch('/departments', token),
      apiFetch('/system/status', token),
    ]);
    if (!empRes.ok) {
      setError('Could not load employees.');
      return;
    }
    setEmployees((await empRes.json()) as EmployeeRow[]);
    if (deptRes.ok) {
      setDepartments((await deptRes.json()) as Department[]);
    }
    if (sysRes.ok) {
      const s = await sysRes.json();
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
      setAiBriefingsOn(s.ai_status !== false);
      setMailboxCrawlOn(s.email_crawl_enabled !== false);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    const user = authMe as Me;
    setMe(user);
    if (user.role === 'EMPLOYEE') {
      router.replace('/dashboard');
      return;
    }
    if ((user.role === 'HEAD' || user.role === 'MANAGER') && user.department_id) {
      setDepartmentId(user.department_id);
    }
    void loadLists(token);
  }, [authLoading, authMe, token, router]);

  /** After Google redirects back from /auth/google/callback (success or error). */
  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;

    if (oauthErr) {
      const help: Record<string, string> = {
        exchange_failed:
          'Gmail connection could not be completed. Confirm Railway GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI match your Google Cloud web client, then try Connect Gmail again.',
        access_denied: 'Google sign-in was cancelled or denied.',
        not_configured: 'Server is missing Google OAuth configuration.',
        missing_code_or_state: 'Invalid return from Google. Click Connect Gmail again.',
      };
      setError(help[oauthErr] ?? `Gmail connection failed (${oauthErr}).`);
    }
    if (connected === '1') {
      setAddSuccess('Gmail connected successfully.');
      void loadLists(token);
    }

    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id']) params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadLists is stable enough for this callback
  }, [authLoading, token, searchParams, pathname, router]);

  useEffect(() => {
    if (!me || (me.role !== 'HEAD' && me.role !== 'MANAGER')) {
      setDashStats({});
      return;
    }
    let cancelled = false;
    (async () => {
      if (!token) return;
      const res = await apiFetch('/dashboard', token);
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as { conversations?: DashboardConv[] };
      const conv = body.conversations ?? [];
      const map: Record<string, { pending: number; missed: number }> = {};
      for (const c of conv) {
        const id = c.employee_id;
        if (!map[id]) map[id] = { pending: 0, missed: 0 };
        if (c.follow_up_status === 'PENDING') map[id].pending++;
        if (c.follow_up_status === 'MISSED') map[id].missed++;
      }
      if (!cancelled) setDashStats(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [me, employees.length, token]);

  async function connectGmail(employeeId: string) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch(`/auth/gmail/authorize-url?employee_id=${encodeURIComponent(employeeId)}`, session.access_token);
    const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
    if (!res.ok || !body.url) {
      setError(body.message || 'Could not start Gmail connection');
      return;
    }
    window.location.href = body.url;
  }

  async function deleteEmployee(employeeId: string, employeeName: string) {
    setError(null);
    const confirmed = window.confirm(`Delete employee "${employeeName}"? This cannot be undone.`);
    if (!confirmed) return;
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch(`/employees/${encodeURIComponent(employeeId)}`, session.access_token, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError((b.message as string) || 'Could not delete employee');
      return;
    }
    await loadLists(session.access_token);
  }

  async function saveSla(employeeId: string) {
    setError(null);
    setNotice(null);
    const employee = employees.find((e) => e.id === employeeId);
    const raw = (slaInputs[employeeId] ?? String(employee?.sla_hours_default ?? 24)).trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) {
      setError('Enter a valid SLA hour value.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setError('Session expired — refresh the page or sign in again.');
      return;
    }
    setSlaSavingFor(employeeId);
    try {
      const res = await apiFetch(`/employees/${encodeURIComponent(employeeId)}/sla`, session.access_token, {
        method: 'PATCH',
        body: JSON.stringify({ sla_hours: value }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update SLA');
        return;
      }
      setSlaInputs((prev) => {
        const next = { ...prev };
        delete next[employeeId];
        return next;
      });
      await loadLists(session.access_token);
      flashNotice(`SLA saved (${value}h) for ${employee?.name ?? 'mailbox'}.`);
    } finally {
      setSlaSavingFor(null);
    }
  }

  async function viewMessages(employeeId: string) {
    setError(null);
    setMessagesLoadingFor(employeeId);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch(
        `/employees/${encodeURIComponent(employeeId)}/messages?limit=10`,
        session.access_token,
      );
      const body = (await res.json().catch(() => ({}))) as { messages?: EmployeeMessage[]; message?: string };
      if (!res.ok) {
        setError(body.message || 'Could not load messages');
        return;
      }
      setMessagesByEmployee((prev) => ({ ...prev, [employeeId]: body.messages ?? [] }));
    } finally {
      setMessagesLoadingFor(null);
    }
  }

  async function saveTrackingStart(employeeId: string) {
    setError(null);
    setNotice(null);
    const employee = employees.find((e) => e.id === employeeId);
    const raw =
      trackingInputs[employeeId] ??
      (employee?.tracking_start_at ? toLocalDatetimeLocalValue(new Date(employee.tracking_start_at)) : '');
    if (!raw.trim()) {
      setError('Pick start date and time.');
      return;
    }
    const asIso = new Date(raw).toISOString();
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setError('Session expired — refresh the page or sign in again.');
      return;
    }
    setTrackingSavingFor(employeeId);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(employeeId)}/tracking-start`,
        session.access_token,
        {
          method: 'PATCH',
          body: JSON.stringify({ tracking_start_at: asIso }),
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update tracking start');
        return;
      }
      setTrackingInputs((prev) => {
        const next = { ...prev };
        delete next[employeeId];
        return next;
      });
      await loadLists(session.access_token);
      flashNotice(
        `Tracking start saved (${new Date(asIso).toLocaleString()}) for ${employee?.name ?? 'mailbox'}. Gmail fetch window was reset to match.`,
      );
    } finally {
      setTrackingSavingFor(null);
    }
  }

  async function patchEmployeePauses(employeeId: string, body: { tracking_paused?: boolean; ai_enabled?: boolean }) {
    setError(null);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    setPauseSavingFor(employeeId);
    try {
      const res = await apiFetch(`/employees/${encodeURIComponent(employeeId)}/pauses`, session.access_token, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update mailbox pauses');
        return;
      }
      await loadLists(session.access_token);
    } finally {
      setPauseSavingFor(null);
    }
  }

  function emailFetchOn(emp: EmployeeRow): boolean {
    return emp.tracking_paused !== true;
  }

  function aiOn(emp: EmployeeRow): boolean {
    return emp.ai_enabled !== false;
  }

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((emp) =>
      [emp.name, emp.email, emp.department_name].some((v) => v.toLowerCase().includes(q)),
    );
  }, [employees, searchQuery]);

  const sortedEmployees = useMemo(() => {
    const arr = [...filteredEmployees];
    arr.sort((a, b) => {
      const dir = sortOrder === 'asc' ? 1 : -1;
      if (sortBy === 'name') return a.name.localeCompare(b.name) * dir;
      if (sortBy === 'department') return a.department_name.localeCompare(b.department_name) * dir;
      if (sortBy === 'gmail') {
        const ag = a.gmail_connected ? 1 : 0;
        const bg = b.gmail_connected ? 1 : 0;
        return (ag - bg) * dir;
      }
      const at = a.last_synced_at ? new Date(a.last_synced_at).getTime() : 0;
      const bt = b.last_synced_at ? new Date(b.last_synced_at).getTime() : 0;
      return (at - bt) * dir;
    });
    return arr;
  }, [filteredEmployees, sortBy, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(sortedEmployees.length / PAGE_SIZE));
  const pagedEmployees = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sortedEmployees.slice(start, start + PAGE_SIZE);
  }, [sortedEmployees, currentPage]);

  const focusEmployeeId = searchParams.get('focus');
  useEffect(() => {
    if (!focusEmployeeId || typeof window === 'undefined') return;
    const id = window.setTimeout(() => {
      document.getElementById(`emp-card-${focusEmployeeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => window.clearTimeout(id);
  }, [focusEmployeeId, sortedEmployees.length, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy, sortOrder]);

  useEffect(() => {
    if (pathname !== '/employees' || typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('add') === '1') setAddOpen(true);
  }, [pathname]);

  function closeAddModal() {
    setAddOpen(false);
    setAddError(null);
    setAddSuccess(null);
    if (typeof window !== 'undefined' && window.location.search.includes('add=')) {
      router.replace('/employees', { scroll: false });
    }
  }

  async function submitAddEmployee(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAddSuccess(null);
    if (addPassword.length < 8) {
      setAddError('Password must be at least 8 characters.');
      return;
    }
    if (addPassword !== addConfirm) {
      setAddError('Passwords do not match.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session || !me) return;
    const dep =
      (me.role === 'HEAD' || me.role === 'MANAGER') && me.department_id ? me.department_id : addDeptId.trim();
    if (!dep) {
      setAddError(isManager ? 'Your account has no department assigned.' : 'Select a department.');
      return;
    }
    setAddSaving(true);
    try {
      const res = await apiFetch('/employees', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          name: addName.trim(),
          email: addEmail.trim(),
          departmentId: dep,
          password: addPassword,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError((b.message as string) || 'Could not create employee');
        return;
      }
      setAddName('');
      setAddEmail('');
      setAddPassword('');
      setAddConfirm('');
      setAddSuccess('Team member added. Share credentials securely.');
      await loadLists(session.access_token);
    } finally {
      setAddSaving(false);
    }
  }

  function toggleSort(field: 'name' | 'department' | 'gmail' | 'last_sync') {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(field);
    setSortOrder(field === 'name' || field === 'department' ? 'asc' : 'desc');
  }

  if (!me || authLoading) {
    return (
      <AppShell role="CEO" title="Employees" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title={isManager ? 'Team' : 'Employees'}
      subtitle={
        isManager
          ? `${managerDepartmentName ?? 'Your department'} — mailboxes and workload.`
          : 'Mailboxes, departments, and connection status.'
      }
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      aiBriefingsEnabled={aiBriefingsOn}
      mailboxCrawlEnabled={mailboxCrawlOn}
      onRefresh={() => {
        void (async () => {
          const supabase = createClient();
          const { data: { session } } = await supabase.auth.getSession();
          if (session) await loadLists(session.access_token);
        })();
      }}
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? (
        <p className="text-sm text-emerald-800" role="status">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-slate-500">{isManager ? 'People you manage' : 'Organization'}</p>
        <button
          type="button"
          onClick={() => {
            setAddError(null);
            setAddSuccess(null);
            setAddOpen(true);
          }}
          className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95"
        >
          {isManager ? 'Add team member' : 'Add employee'}
        </button>
      </div>
      <div>
        <section className="rounded-2xl border border-slate-200/60 bg-surface-card p-6 shadow-card">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-lg font-bold text-slate-900">{isManager ? 'Team members' : 'Directory'}</h2>
            <div className="min-w-[260px] flex-1 sm:max-w-xs">
              <label htmlFor="employee-search" className="mb-1 block text-xs font-medium text-gray-500">
                Search employee
              </label>
              <input
                id="employee-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Name, email, or department"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          {(isManager || isCeo) && employees.length > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              {isManager
                ? 'Pause Email fetch or AI on a card for that mailbox only — other team members are unchanged.'
                : 'Email / AI columns pause one mailbox at a time. Company-wide switches live under Settings.'}
            </p>
          ) : null}
          {employees.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Add people to get started.</p>
          ) : sortedEmployees.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No matches.</p>
          ) : isManager ? (
            <>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {pagedEmployees.map((emp) => {
                  const st = dashStats[emp.id] ?? { pending: 0, missed: 0 };
                  const isFocus = focusEmployeeId === emp.id;
                  return (
                    <article
                      key={emp.id}
                      id={`emp-card-${emp.id}`}
                      className={`rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm transition-shadow hover:shadow-card-hover ${
                        isFocus ? 'ring-2 ring-brand-500 ring-offset-2' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-bold text-slate-900">{emp.name}</p>
                          <p className="mt-1 truncate text-sm text-slate-500">{emp.email}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
                          <span className={`h-2 w-2 rounded-full ${emp.gmail_connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          <span className={emp.gmail_connected ? 'text-emerald-700' : 'text-amber-800'}>
                            {emp.gmail_connected ? 'Active' : 'Setup'}
                          </span>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-surface-muted/90 p-4">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Pending</p>
                          <p className="mt-0.5 text-2xl font-bold tabular-nums text-amber-700">{st.pending}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Missed SLA</p>
                          <p className="mt-0.5 text-2xl font-bold tabular-nums text-red-600">{st.missed}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                        <button
                          type="button"
                          onClick={() => void connectGmail(emp.id)}
                          className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2 text-xs font-semibold text-white hover:opacity-95"
                        >
                          {emp.gmail_connected ? 'Reconnect' : 'Connect Gmail'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void viewMessages(emp.id)}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Inbox sample
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteEmployee(emp.id, emp.name)}
                          className="rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-slate-500">SLA (h)</span>
                        <input
                          type="number"
                          min={1}
                          max={168}
                          value={slaInputs[emp.id] ?? String(emp.sla_hours_default ?? 24)}
                          onChange={(e) =>
                            setSlaInputs((prev) => ({
                              ...prev,
                              [emp.id]: e.target.value,
                            }))
                          }
                          className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-xs focus:ring-2 focus:ring-brand-500"
                        />
                        <button
                          type="button"
                          onClick={() => void saveSla(emp.id)}
                          className="rounded-lg border border-slate-200 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Save
                        </button>
                      </div>
                      <div className="mt-3 space-y-2 rounded-xl border border-slate-100 bg-white/80 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">This mailbox only</p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-slate-600">Email fetch</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={emailFetchOn(emp)}
                            disabled={pauseSavingFor === emp.id}
                            onClick={() =>
                              void patchEmployeePauses(emp.id, { tracking_paused: emailFetchOn(emp) })
                            }
                            title={emailFetchOn(emp) ? 'Pause Gmail sync for this person' : 'Resume Gmail sync'}
                            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${emailFetchOn(emp) ? 'bg-indigo-600' : 'bg-slate-300'} ${pauseSavingFor === emp.id ? 'opacity-50' : ''}`}
                          >
                            <span
                              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${emailFetchOn(emp) ? 'left-6' : 'left-0.5'}`}
                            />
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-slate-600">AI</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={aiOn(emp)}
                            disabled={pauseSavingFor === emp.id}
                            onClick={() => void patchEmployeePauses(emp.id, { ai_enabled: !aiOn(emp) })}
                            title={aiOn(emp) ? 'Pause AI for this mailbox' : 'Enable AI for this mailbox'}
                            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${aiOn(emp) ? 'bg-indigo-600' : 'bg-slate-300'} ${pauseSavingFor === emp.id ? 'opacity-50' : ''}`}
                          >
                            <span
                              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${aiOn(emp) ? 'left-6' : 'left-0.5'}`}
                            />
                          </button>
                        </div>
                      </div>
                      {messagesLoadingFor === emp.id ? (
                        <p className="mt-2 text-xs text-slate-500">Loading…</p>
                      ) : null}
                      {messagesByEmployee[emp.id]?.length ? (
                        <ul className="mt-2 space-y-1 rounded-xl border border-slate-100 bg-surface-muted/50 p-2">
                          {messagesByEmployee[emp.id].map((m) => (
                            <li key={m.provider_message_id} className="text-xs text-slate-600">
                              <span className="font-medium text-slate-800">{m.subject || '(no subject)'}</span> ·{' '}
                              {new Date(m.sent_at).toLocaleDateString()}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
                <span>
                  {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, sortedEmployees.length)} of{' '}
                  {sortedEmployees.length}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <span>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-100">
              <table className="min-w-[1100px] w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('name')} className="font-semibold hover:text-slate-800">
                        Employee {sortBy === 'name' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('department')} className="font-semibold hover:text-slate-800">
                        Department {sortBy === 'department' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('gmail')} className="font-semibold hover:text-slate-800">
                        Status {sortBy === 'gmail' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('last_sync')} className="font-semibold hover:text-slate-800">
                        Last sync {sortBy === 'last_sync' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">SLA (h)</th>
                    <th className="px-3 py-3">Tracking Start</th>
                    <th className="px-3 py-3 w-[140px]">Email / AI</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white align-top">
                  {pagedEmployees.map((emp) => (
                    <tr key={emp.id} className="hover:bg-slate-50/80">
                      <td className="px-3 py-3">
                        <p className="font-medium text-slate-900">{emp.name}</p>
                        <p className="text-xs text-slate-500">{emp.email}</p>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-700">{emp.department_name}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`h-2 w-2 rounded-full ${emp.gmail_connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          <span className={emp.gmail_connected ? 'font-medium text-emerald-700' : 'font-medium text-amber-800'}>
                            {emp.gmail_connected ? 'Active' : 'Setup'}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-600">
                        {emp.last_synced_at ? new Date(emp.last_synced_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={168}
                            value={slaInputs[emp.id] ?? String(emp.sla_hours_default ?? 24)}
                            onChange={(e) =>
                              setSlaInputs((prev) => ({
                                ...prev,
                                [emp.id]: e.target.value,
                              }))
                            }
                            disabled={slaSavingFor === emp.id}
                            className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                            placeholder="24"
                          />
                          <button
                            type="button"
                            onClick={() => void saveSla(emp.id)}
                            disabled={slaSavingFor === emp.id}
                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {slaSavingFor === emp.id ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="datetime-local"
                            value={
                              trackingInputs[emp.id] ??
                              (emp.tracking_start_at
                                ? toLocalDatetimeLocalValue(new Date(emp.tracking_start_at))
                                : '')
                            }
                            onChange={(e) =>
                              setTrackingInputs((prev) => ({
                                ...prev,
                                [emp.id]: e.target.value,
                              }))
                            }
                            disabled={trackingSavingFor === emp.id}
                            className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                          />
                          <button
                            type="button"
                            onClick={() => void saveTrackingStart(emp.id)}
                            disabled={trackingSavingFor === emp.id}
                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {trackingSavingFor === emp.id ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[10px] text-slate-500">Email</span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={emailFetchOn(emp)}
                              disabled={pauseSavingFor === emp.id}
                              onClick={() =>
                                void patchEmployeePauses(emp.id, { tracking_paused: emailFetchOn(emp) })
                              }
                              className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${emailFetchOn(emp) ? 'bg-indigo-600' : 'bg-slate-300'} ${pauseSavingFor === emp.id ? 'opacity-50' : ''}`}
                            >
                              <span
                                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${emailFetchOn(emp) ? 'left-5' : 'left-0.5'}`}
                              />
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[10px] text-slate-500">AI</span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={aiOn(emp)}
                              disabled={pauseSavingFor === emp.id}
                              onClick={() => void patchEmployeePauses(emp.id, { ai_enabled: !aiOn(emp) })}
                              className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${aiOn(emp) ? 'bg-indigo-600' : 'bg-slate-300'} ${pauseSavingFor === emp.id ? 'opacity-50' : ''}`}
                            >
                              <span
                                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${aiOn(emp) ? 'left-5' : 'left-0.5'}`}
                              />
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void connectGmail(emp.id)}
                            className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs text-white transition-all duration-200 hover:bg-blue-700"
                          >
                            {emp.gmail_connected ? 'Reconnect' : 'Connect'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void viewMessages(emp.id)}
                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50"
                          >
                            View mails
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteEmployee(emp.id, emp.name)}
                            className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-700 transition-all duration-200 hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                        {messagesLoadingFor === emp.id ? (
                          <p className="mt-2 text-xs text-gray-500">Loading emails...</p>
                        ) : null}
                        {messagesByEmployee[emp.id]?.length ? (
                          <ul className="mt-2 space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-2">
                            {messagesByEmployee[emp.id].map((m) => (
                              <li key={m.provider_message_id} className="text-xs text-gray-700">
                                <span className="font-medium">{m.subject || '(no subject)'}</span> - {m.from_email}{' '}
                                - {new Date(m.sent_at).toLocaleString()}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
                <span>
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, sortedEmployees.length)} of {sortedEmployees.length}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="rounded border border-gray-300 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <span>Page {currentPage} / {totalPages}</span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded border border-gray-300 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {addOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-emp-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closeAddModal();
          }}
        >
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 id="add-emp-title" className="text-lg font-semibold text-slate-900">
              {isManager ? 'Add team member' : 'Add employee'}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Work email and password for the employee portal.
            </p>
            <form onSubmit={(e) => void submitAddEmployee(e)} className="mt-4 space-y-3">
              {addError ? <p className="text-sm text-red-600">{addError}</p> : null}
              {addSuccess ? <p className="text-sm text-emerald-700">{addSuccess}</p> : null}
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Full name"
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                required
                autoFocus
              />
              <input
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="Work email"
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                required
                autoComplete="off"
              />
              <input
                type="password"
                value={addPassword}
                onChange={(e) => setAddPassword(e.target.value)}
                placeholder="Password (min 8 characters)"
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                required
                minLength={8}
                autoComplete="new-password"
              />
              <input
                type="password"
                value={addConfirm}
                onChange={(e) => setAddConfirm(e.target.value)}
                placeholder="Confirm password"
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                required
                minLength={8}
                autoComplete="new-password"
              />
              {isManager ? (
                <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  Department:{' '}
                  <span className="font-medium text-slate-900">{managerDepartmentName ?? '—'}</span>
                </div>
              ) : (
                <select
                  value={addDeptId}
                  onChange={(e) => setAddDeptId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500"
                  required
                >
                  <option value="">Department</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="submit"
                  disabled={addSaving}
                  className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {addSaving ? 'Saving…' : 'Add'}
                </button>
                <button
                  type="button"
                  onClick={() => closeAddModal()}
                  className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

export default function EmployeesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center bg-surface text-sm text-slate-500">Loading…</div>
      }
    >
      <EmployeesPageInner />
    </Suspense>
  );
}
