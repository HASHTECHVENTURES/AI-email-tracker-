'use client';

import { useCallback, useEffect, useState } from 'react';
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

type MailRow = {
  provider_message_id: string;
  provider_thread_id: string;
  subject: string;
  from_email: string;
  direction: string;
  sent_at: string;
  employee_id: string;
  employee_name: string;
  body_preview: string;
};

type EmployeeOption = { id: string; name: string };

const PAGE_SIZE = 25;

export default function EmailArchivePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [items, setItems] = useState<MailRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterEmployee, setFilterEmployee] = useState('');
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [detail, setDetail] = useState<MailRow | null>(null);

  const loadArchive = useCallback(
    async (token: string, nextOffset: number, empFilter: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        qs.set('limit', String(PAGE_SIZE));
        qs.set('offset', String(nextOffset));
        if (empFilter) qs.set('employee_id', empFilter);
        const res = await apiFetch(`/dashboard/email-archive?${qs.toString()}`, token);
        const body = (await res.json().catch(() => ({}))) as {
          total?: number;
          items?: MailRow[];
          message?: string;
        };
        if (!res.ok) {
          setError(body.message || 'Could not load email archive.');
          return;
        }
        setTotal(body.total ?? 0);
        setItems(body.items ?? []);
        setOffset(nextOffset);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

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

      const sysRes = await apiFetch('/system/status', session.access_token);
      if (sysRes.ok) {
        const s = await sysRes.json();
        setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
        setIsActive(Boolean(s.is_active));
      }
      if (user.role !== 'EMPLOYEE') {
        const empRes = await apiFetch('/employees', session.access_token);
        if (empRes.ok) {
          const list = (await empRes.json()) as Array<{ id: string; name: string }>;
          setEmployees(list.map((e) => ({ id: e.id, name: e.name })));
        }
      }

      await loadArchive(session.access_token, 0, '');
    })();
    return () => {
      cancelled = true;
    };
  }, [router, loadArchive]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  async function applyFilter(nextOffset: number) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    await loadArchive(session.access_token, nextOffset, filterEmployee);
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">{error ?? 'Loading...'}</div>;

  const isEmployee = me.role === 'EMPLOYEE';
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';
  const archiveSubtitle = isEmployee
    ? 'Ingested mail for your mailbox only.'
    : isHead
      ? 'Ingested mail for your department’s mailboxes only (same scope as your dashboard).'
      : 'Ingested mail across all tracked company mailboxes.';
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Email archive"
      subtitle={archiveSubtitle}
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      onRefresh={() => void applyFilter(offset)}
      onSignOut={() => void signOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!isEmployee ? (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="archive-emp" className="mb-1 block text-xs font-medium text-gray-500">
              Filter by mailbox
            </label>
            <select
              id="archive-emp"
              value={filterEmployee}
              onChange={(e) => setFilterEmployee(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All tracked employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void applyFilter(0)}
            disabled={loading}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
          >
            Apply
          </button>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3 text-sm text-gray-600">
          {total === 0 ? 'No messages in archive yet.' : `${total} message${total === 1 ? '' : 's'} stored`}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Sent</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3">Subject</th>
                {!isEmployee ? <th className="px-4 py-3">Employee</th> : null}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((row) => (
                <tr key={row.provider_message_id} className="hover:bg-gray-50/80">
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">{new Date(row.sent_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.direction === 'INBOUND' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {row.direction}
                    </span>
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-gray-800">{row.from_email}</td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-gray-800">{row.subject}</td>
                  {!isEmployee ? <td className="px-4 py-3 text-gray-600">{row.employee_name}</td> : null}
                  <td className="whitespace-nowrap px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setDetail(row)}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm text-gray-600">
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={loading || offset <= 0}
                onClick={() => void applyFilter(Math.max(0, offset - PAGE_SIZE))}
                className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={loading || offset + PAGE_SIZE >= total}
                onClick={() => void applyFilter(offset + PAGE_SIZE)}
                className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {detail ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-gray-100 bg-gray-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">{detail.subject}</h2>
              <p className="mt-1 text-sm text-gray-500">
                {new Date(detail.sent_at).toLocaleString()} · {detail.direction} · {detail.from_email}
              </p>
              {!isEmployee ? <p className="mt-1 text-sm text-gray-600">Mailbox: {detail.employee_name}</p> : null}
            </div>
            <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-800">{detail.body_preview || 'No body stored.'}</pre>
            </div>
            <div className="border-t border-gray-100 px-6 py-3 text-right">
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
