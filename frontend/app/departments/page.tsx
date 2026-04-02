'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

type Me = {
  id: string;
  role: string;
  company_name?: string | null;
  department_id: string | null;
};

type Department = {
  id: string;
  name: string;
  employee_count?: number;
  manager?: {
    id: string;
    email: string;
    full_name: string | null;
  } | null;
};

type TeamMember = {
  id: string;
  name: string;
  email: string;
  department_id: string;
  department_name: string;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  has_portal_login?: boolean;
};

export default function DepartmentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [managerName, setManagerName] = useState('');
  const [managerPassword, setManagerPasswordInput] = useState('');
  const [managerDepartmentId, setManagerDepartmentId] = useState('');
  const [passwordDepartmentId, setPasswordDepartmentId] = useState('');
  const [newManagerPassword, setNewManagerPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [teamLoadError, setTeamLoadError] = useState<string | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<TeamMember | null>(null);
  const [portalPassword, setPortalPassword] = useState('');
  const [portalPasswordConfirm, setPortalPasswordConfirm] = useState('');
  const [portalPasswordSaving, setPortalPasswordSaving] = useState(false);
  const [portalPasswordError, setPortalPasswordError] = useState<string | null>(null);
  const [alertTarget, setAlertTarget] = useState<TeamMember | null>(null);
  const [alertMessage, setAlertMessage] = useState('');
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const load = useCallback(async (token: string) => {
    const res = await apiFetch('/departments', token);
    if (!res.ok) {
      setError('Could not load departments');
      return;
    }
    setRows((await res.json()) as Department[]);
  }, []);

  const loadTeam = useCallback(async (token: string) => {
    setTeamLoadError(null);
    const res = await apiFetch('/employees', token);
    if (!res.ok) {
      setTeamLoadError('Could not load team list');
      setTeamMembers([]);
      return;
    }
    setTeamMembers((await res.json()) as TeamMember[]);
  }, []);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return router.replace('/auth');
      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) return router.replace('/auth');
      const m = (await meRes.json()) as Me;
      setMe(m);
      if (m.role === 'EMPLOYEE') return router.replace('/dashboard');
      await load(session.access_token);
      if (m.role === 'HEAD' || m.role === 'MANAGER') {
        await loadTeam(session.access_token);
      }
    })();
  }, [router, load, loadTeam]);

  useEffect(() => {
    if (pathname !== '/departments') return;
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#team-members') return;
    const el = document.getElementById('team-members');
    if (!el) return;
    const t = window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => window.clearTimeout(t);
  }, [pathname]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  async function reloadTeam() {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session) await loadTeam(session.access_token);
  }

  function openPortalPasswordModal(member: TeamMember) {
    setPortalPasswordError(null);
    setPortalPassword('');
    setPortalPasswordConfirm('');
    setPasswordTarget(member);
  }

  function closePortalPasswordModal() {
    setPasswordTarget(null);
    setPortalPasswordError(null);
    setPortalPassword('');
    setPortalPasswordConfirm('');
  }

  function openAlertModal(member: TeamMember) {
    setAlertError(null);
    setAlertMessage('');
    setAlertTarget(member);
  }

  function closeAlertModal() {
    setAlertTarget(null);
    setAlertMessage('');
    setAlertError(null);
  }

  async function submitTeamAlert(e: React.FormEvent) {
    e.preventDefault();
    setAlertError(null);
    if (!alertTarget) return;
    const text = alertMessage.trim();
    if (!text) {
      setAlertError('Enter a message for your team member.');
      return;
    }
    setAlertSaving(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch('/team-alerts/send', session.access_token, {
        method: 'POST',
        body: JSON.stringify({ employeeId: alertTarget.id, message: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAlertError((body.message as string) || 'Could not send alert');
        return;
      }
      closeAlertModal();
      setError(null);
      setNotice(`Alert sent to ${alertTarget.name}. They will see it on their dashboard.`);
    } finally {
      setAlertSaving(false);
    }
  }

  async function submitPortalPassword(e: React.FormEvent) {
    e.preventDefault();
    setPortalPasswordError(null);
    if (!passwordTarget) return;
    if (portalPassword.length < 8) {
      setPortalPasswordError('Password must be at least 8 characters.');
      return;
    }
    if (portalPassword !== portalPasswordConfirm) {
      setPortalPasswordError('Passwords do not match.');
      return;
    }
    setPortalPasswordSaving(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const res = await apiFetch(
        `/employees/portal-password/${encodeURIComponent(passwordTarget.id)}`,
        session.access_token,
        { method: 'PATCH', body: JSON.stringify({ password: portalPassword }) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPortalPasswordError((body.message as string) || 'Could not save password');
        return;
      }
      const action = (body as { action?: string }).action;
      const memberName = passwordTarget.name;
      closePortalPasswordModal();
      setError(null);
      setNotice(
        action === 'login_created'
          ? `Employee portal login created for ${memberName}. Share the email and new password securely.`
          : `Password updated for ${memberName}. Share the new password securely.`,
      );
      await reloadTeam();
    } finally {
      setPortalPasswordSaving(false);
    }
  }

  async function addDepartment(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch('/departments', session.access_token, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    if (!res.ok) return setError('Could not create department');
    setName('');
    setNotice('Department created.');
    await load(session.access_token);
  }

  async function assignManager(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    if (!managerDepartmentId || !managerEmail.trim()) {
      setError('Department and manager email are required');
      return;
    }
    const res = await apiFetch(
      `/departments/${encodeURIComponent(managerDepartmentId)}/assign-manager`,
      session.access_token,
      {
        method: 'POST',
        body: JSON.stringify({
          email: managerEmail.trim().toLowerCase(),
          full_name: managerName.trim() || undefined,
          password: managerPassword.trim() || undefined,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body.message as string) || 'Could not assign manager');
      return;
    }
    setManagerEmail('');
    setManagerName('');
    setManagerPasswordInput('');
    setManagerDepartmentId('');
    setNotice('Manager assigned successfully.');
    await load(session.access_token);
  }

  async function handleManagerPasswordReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    if (!passwordDepartmentId || !newManagerPassword.trim()) {
      setError('Department and new password are required');
      return;
    }
    const res = await apiFetch(
      `/departments/${encodeURIComponent(passwordDepartmentId)}/manager-password`,
      session.access_token,
      {
        method: 'POST',
        body: JSON.stringify({ password: newManagerPassword.trim() }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body.message as string) || 'Could not reset manager password');
      return;
    }
    setPasswordDepartmentId('');
    setNewManagerPassword('');
    setNotice('Manager password updated.');
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  const isCeo = me.role === 'CEO';
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title={isCeo ? 'Departments' : 'My department'}
      subtitle={
        isCeo
          ? 'Create departments, assign managers, and reset manager passwords.'
          : 'Read-only overview of the department you manage. Org changes are CEO-only.'
      }
      onSignOut={() => void signOut()}
    >
      {isCeo ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Add Department</h2>
          <form onSubmit={(e) => void addDepartment(e)} className="mt-4 flex flex-wrap gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-[260px] flex-1 rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500" placeholder="Department name" required />
            <button className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-blue-700 hover:shadow-md">Add Department</button>
          </form>
        </section>
      ) : null}

      {isCeo ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Change Manager Password</h2>
          <p className="mt-1 text-sm text-gray-500">
            For security, existing passwords can never be viewed. You can set a new password anytime.
          </p>
          <form onSubmit={(e) => void handleManagerPasswordReset(e)} className="mt-4 flex flex-wrap gap-3">
            <select
              value={passwordDepartmentId}
              onChange={(e) => setPasswordDepartmentId(e.target.value)}
              className="min-w-[220px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select department</option>
              {rows.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input
              type="password"
              value={newManagerPassword}
              onChange={(e) => setNewManagerPassword(e.target.value)}
              className="min-w-[260px] flex-1 rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="New password (min 8 chars)"
              required
            />
            <button className="rounded-lg bg-gray-900 px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-black hover:shadow-md">
              Update Password
            </button>
          </form>
        </section>
      ) : null}

      {isCeo ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Assign Manager</h2>
          <p className="mt-1 text-sm text-gray-500">
            Assign an existing company user, or create a new manager account by adding password.
          </p>
          <form onSubmit={(e) => void assignManager(e)} className="mt-4 flex flex-wrap gap-3">
            <select
              value={managerDepartmentId}
              onChange={(e) => setManagerDepartmentId(e.target.value)}
              className="min-w-[220px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select department</option>
              {rows.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
              className="min-w-[220px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Manager name (optional)"
            />
            <input
              type="email"
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              className="min-w-[260px] flex-1 rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Manager email"
              required
            />
            <input
              type="password"
              value={managerPassword}
              onChange={(e) => setManagerPasswordInput(e.target.value)}
              className="min-w-[220px] rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              placeholder="Password (required if user not exists)"
            />
            <button className="rounded-lg bg-gray-900 px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-black hover:shadow-md">
              Assign Manager
            </button>
          </form>
        </section>
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Department List</h2>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-emerald-700">{notice}</p> : null}
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No departments yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {rows.map((d) => (
              <li key={d.id} className="flex items-center justify-between rounded-lg border border-gray-200 p-4 transition-all duration-200 hover:bg-gray-50">
                <div>
                  <p className="font-medium text-gray-900">{d.name}</p>
                  <p className="mt-1 text-sm text-gray-500">
                    Manager:{' '}
                    {d.manager
                      ? `${d.manager.full_name?.trim() || 'Unnamed'} (${d.manager.email})`
                      : 'Not assigned'}
                  </p>
                </div>
                <p className="text-sm text-gray-500">{d.employee_count ?? 0} employees</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isHead ? (
        <section
          id="team-members"
          className="rounded-xl border border-amber-200/80 bg-white p-6 shadow-sm ring-1 ring-amber-900/[0.04] scroll-mt-24"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Team members</h2>
            <p className="text-sm text-gray-500">
              Set up or change Employee portal passwords below. Existing passwords are never shown.
            </p>
          </div>
          {teamLoadError ? <p className="text-sm text-red-600">{teamLoadError}</p> : null}
          {!teamLoadError && teamMembers.length === 0 ? (
            <p className="text-sm text-gray-500">
              No team members yet. Use <span className="font-medium text-gray-700">Add team member</span> in the sidebar
              to add tracked mailboxes.
            </p>
          ) : null}
          {teamMembers.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Login email</th>
                    <th className="px-4 py-3">Gmail</th>
                    <th className="px-4 py-3">Last sync</th>
                    <th className="px-4 py-3">Portal login</th>
                    <th className="px-4 py-3">Alert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {teamMembers.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50/80">
                      <td className="px-4 py-3 font-medium text-gray-900">{e.name}</td>
                      <td className="px-4 py-3 text-gray-600">{e.email}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            (e.gmail_status ?? 'EXPIRED') === 'CONNECTED'
                              ? 'font-medium text-emerald-700'
                              : 'font-medium text-amber-800'
                          }
                        >
                          {(e.gmail_status ?? 'EXPIRED') === 'CONNECTED' ? 'Connected' : 'Not connected'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {e.last_synced_at ? new Date(e.last_synced_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openPortalPasswordModal(e)}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100"
                        >
                          {e.has_portal_login ? 'Change password' : 'Set up password'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openAlertModal(e)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-800 transition hover:bg-gray-50"
                        >
                          Send alert
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {alertTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="team-alert-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closeAlertModal();
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 id="team-alert-title" className="text-lg font-semibold text-gray-900">
              Message to {alertTarget.name}
            </h3>
            <p className="mt-1 text-sm text-gray-600">
              They will see this at the top of their Employee dashboard. Use for reminders or priorities — not a substitute
              for email.
            </p>
            <form onSubmit={(e) => void submitTeamAlert(e)} className="mt-4 space-y-3">
              {alertError ? <p className="text-sm text-red-600">{alertError}</p> : null}
              <textarea
                value={alertMessage}
                onChange={(ev) => setAlertMessage(ev.target.value)}
                placeholder="Your message…"
                rows={4}
                maxLength={4000}
                className="w-full resize-y rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500"
                required
              />
              <p className="text-xs text-gray-500">{alertMessage.length} / 4000 characters</p>
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="submit"
                  disabled={alertSaving}
                  className="rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-60"
                >
                  {alertSaving ? 'Sending…' : 'Send alert'}
                </button>
                <button
                  type="button"
                  onClick={() => closeAlertModal()}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {passwordTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-password-title"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) closePortalPasswordModal();
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 id="portal-password-title" className="text-lg font-semibold text-gray-900">
              {passwordTarget.has_portal_login ? 'Change password' : 'Set up Employee portal login'}
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              {passwordTarget.name} · <span className="font-medium text-gray-800">{passwordTarget.email}</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">
              They sign in at the Employee portal with this email and the password you choose. Minimum 8 characters.
            </p>
            <form onSubmit={(e) => void submitPortalPassword(e)} className="mt-4 space-y-3">
              {portalPasswordError ? <p className="text-sm text-red-600">{portalPasswordError}</p> : null}
              <input
                type="password"
                value={portalPassword}
                onChange={(ev) => setPortalPassword(ev.target.value)}
                placeholder="New password"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500"
                minLength={8}
                autoComplete="new-password"
                required
              />
              <input
                type="password"
                value={portalPasswordConfirm}
                onChange={(ev) => setPortalPasswordConfirm(ev.target.value)}
                placeholder="Confirm password"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:ring-2 focus:ring-amber-500"
                minLength={8}
                autoComplete="new-password"
                required
              />
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="submit"
                  disabled={portalPasswordSaving}
                  className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
                >
                  {portalPasswordSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => closePortalPasswordModal()}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
