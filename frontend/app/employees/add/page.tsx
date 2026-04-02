'use client';

import { useEffect, useState } from 'react';
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

export default function AddEmployeePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  const isManager = me?.role === 'HEAD' || me?.role === 'MANAGER';
  const managerDepartmentName =
    isManager && me?.department_id
      ? departments.find((d) => d.id === me.department_id)?.name ?? 'Assigned department'
      : null;

  async function loadPageData(token: string, user: Me) {
    const [deptRes, sysRes] = await Promise.all([
      apiFetch('/departments', token),
      apiFetch('/system/status', token),
    ]);
    if (deptRes.ok) setDepartments((await deptRes.json()) as Department[]);
    if (sysRes.ok) {
      const s = await sysRes.json();
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
    }
    if ((user.role === 'HEAD' || user.role === 'MANAGER') && user.department_id) {
      setDepartmentId(user.department_id);
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
      if (user.role === 'EMPLOYEE') {
        router.replace('/dashboard');
        return;
      }
      setMe(user);
      await loadPageData(session.access_token, user);
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

  async function addEmployee(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session || !me) return;
    const dep =
      (me.role === 'HEAD' || me.role === 'MANAGER') && me.department_id
        ? me.department_id
        : departmentId;
    const res = await apiFetch('/employees', session.access_token, {
      method: 'POST',
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        departmentId: dep,
        password,
      }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError((b.message as string) || 'Could not create employee');
      return;
    }
    setName('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setSuccess(
      'Team member added. Share the work email and password with them securely — they sign in at the Employee portal (Log in → Employee).',
    );
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">{error ?? 'Loading...'}</div>;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title={isManager ? 'Add team member' : 'Add employee'}
      subtitle={
        isManager
          ? `New mailbox is added to ${managerDepartmentName ?? 'your department'} only.`
          : 'Create a tracked mailbox in any department.'
      }
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      onSignOut={() => void signOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {success ? <p className="text-sm text-emerald-700">{success}</p> : null}
      <section className="max-w-xl rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <p className="mb-4 text-sm text-gray-600">
          You create their <span className="font-medium text-gray-900">login email and password</span> here. They use
          the same work email and this password at the Employee portal — they do not self-register a company.
        </p>
        <form onSubmit={(e) => void addEmployee(e)} className="space-y-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
            required
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Work email (login ID)"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
            required
            autoComplete="off"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password for this team member (min 8 characters)"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
            required
            minLength={8}
            autoComplete="new-password"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
            required
            minLength={8}
            autoComplete="new-password"
          />
          {isManager ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
              Department: <span className="font-medium text-gray-900">{managerDepartmentName}</span>
            </div>
          ) : (
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition-all duration-200 hover:bg-blue-700 hover:shadow-md"
          >
            {isManager ? 'Add team member' : 'Add employee'}
          </button>
        </form>
      </section>
    </AppShell>
  );
}
