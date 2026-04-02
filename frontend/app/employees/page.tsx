'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

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
};

type EmployeeMessage = {
  provider_message_id: string;
  subject: string;
  from_email: string;
  sent_at: string;
};

export default function EmployeesPage() {
  const PAGE_SIZE = 8;
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [slaInputs, setSlaInputs] = useState<Record<string, string>>({});
  const [messagesByEmployee, setMessagesByEmployee] = useState<Record<string, EmployeeMessage[]>>({});
  const [messagesLoadingFor, setMessagesLoadingFor] = useState<string | null>(null);
  const [trackingInputs, setTrackingInputs] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState<'name' | 'department' | 'gmail' | 'last_sync'>('last_sync');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const isManager = me?.role === 'HEAD' || me?.role === 'MANAGER';
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
    if (!empRes.ok || !deptRes.ok) {
      setError('Could not load employees.');
      return;
    }
    setEmployees((await empRes.json()) as EmployeeRow[]);
    setDepartments((await deptRes.json()) as Department[]);
    if (sysRes.ok) {
      const s = await sysRes.json();
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
    }
  }

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
      const user = (await meRes.json()) as Me;
      if (cancelled) return;
      setMe(user);
      if (user.role === 'EMPLOYEE') {
        router.replace('/dashboard');
        return;
      }
      if ((user.role === 'HEAD' || user.role === 'MANAGER') && user.department_id) {
        setDepartmentId(user.department_id);
      }
      await loadLists(session.access_token);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

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
    if (!session) return;
    const res = await apiFetch(`/employees/${encodeURIComponent(employeeId)}/sla`, session.access_token, {
      method: 'PATCH',
      body: JSON.stringify({ sla_hours: value }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError((b.message as string) || 'Could not update SLA');
      return;
    }
    await loadLists(session.access_token);
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
    const employee = employees.find((e) => e.id === employeeId);
    const raw =
      trackingInputs[employeeId] ??
      (employee?.tracking_start_at
        ? new Date(employee.tracking_start_at).toISOString().slice(0, 16)
        : '');
    if (!raw.trim()) {
      setError('Pick start date and time.');
      return;
    }
    const asIso = new Date(raw).toISOString();
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
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
    await loadLists(session.access_token);
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

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy, sortOrder]);

  function toggleSort(field: 'name' | 'department' | 'gmail' | 'last_sync') {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(field);
    setSortOrder(field === 'name' || field === 'department' ? 'asc' : 'desc');
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">{error ?? 'Loading...'}</div>;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title={isManager ? 'Team mailboxes' : 'Employee list'}
      subtitle={
        isManager
          ? `Tracked mailboxes in ${managerDepartmentName ?? 'your department'} only.`
          : 'All company mailboxes, departments, and Gmail connection status.'
      }
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      onRefresh={() => {
        void (async () => {
          const supabase = createClient();
          const { data: { session } } = await supabase.auth.getSession();
          if (session) await loadLists(session.access_token);
        })();
      }}
      onSignOut={() => void signOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div>
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Employee List</h2>
            <div className="min-w-[260px] flex-1 sm:max-w-xs">
              <label htmlFor="employee-search" className="mb-1 block text-xs font-medium text-gray-500">
                Search employee
              </label>
              <input
                id="employee-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Name, email, or department"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {employees.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">Add employees to get started</p>
          ) : sortedEmployees.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">No employees match your search.</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-[1100px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('name')} className="font-semibold hover:text-gray-700">
                        Employee {sortBy === 'name' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('department')} className="font-semibold hover:text-gray-700">
                        Department {sortBy === 'department' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('gmail')} className="font-semibold hover:text-gray-700">
                        Gmail {sortBy === 'gmail' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">
                      <button type="button" onClick={() => toggleSort('last_sync')} className="font-semibold hover:text-gray-700">
                        Last Sync {sortBy === 'last_sync' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    <th className="px-3 py-3">SLA (h)</th>
                    <th className="px-3 py-3">Tracking Start</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white align-top">
                  {pagedEmployees.map((emp) => (
                    <tr key={emp.id} className="hover:bg-gray-50/50">
                      <td className="px-3 py-3">
                        <p className="font-medium text-gray-900">{emp.name}</p>
                        <p className="text-xs text-gray-500">{emp.email}</p>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-700">{emp.department_name}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`h-2 w-2 rounded-full ${emp.gmail_connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                          <span className={emp.gmail_connected ? 'text-emerald-700' : 'text-red-700'}>
                            {emp.gmail_connected ? 'Connected' : 'Disconnected'}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600">
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
                            className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500"
                            placeholder="24"
                          />
                          <button
                            type="button"
                            onClick={() => void saveSla(emp.id)}
                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50"
                          >
                            Save
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
                                ? new Date(emp.tracking_start_at).toISOString().slice(0, 16)
                                : '')
                            }
                            onChange={(e) =>
                              setTrackingInputs((prev) => ({
                                ...prev,
                                [emp.id]: e.target.value,
                              }))
                            }
                            className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => void saveTrackingStart(emp.id)}
                            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 transition-all duration-200 hover:bg-gray-50"
                          >
                            Save
                          </button>
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
    </AppShell>
  );
}
