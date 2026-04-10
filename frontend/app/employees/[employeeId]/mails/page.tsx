'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { conversationReadPath } from '@/lib/conversation-read';

type EmployeeMessage = {
  provider_message_id: string;
  provider_thread_id: string;
  subject: string;
  from_email: string;
  sent_at: string;
};

type EmployeeLite = { id: string; name: string; email: string };

function dedupeLatestByThread(messages: EmployeeMessage[]): EmployeeMessage[] {
  const map = new Map<string, EmployeeMessage>();
  for (const m of messages) {
    const tid = m.provider_thread_id ?? '';
    if (!tid) continue;
    const prev = map.get(tid);
    if (!prev || new Date(m.sent_at).getTime() > new Date(prev.sent_at).getTime()) {
      map.set(tid, m);
    }
  }
  return [...map.values()].sort((a, b) => {
    const fa = (a.from_email ?? '').toLowerCase();
    const fb = (b.from_email ?? '').toLowerCase();
    if (fa !== fb) return fa.localeCompare(fb);
    return new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime();
  });
}

export default function EmployeeMailsPage() {
  const router = useRouter();
  const params = useParams();
  const employeeId = typeof params.employeeId === 'string' ? params.employeeId : '';

  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [employee, setEmployee] = useState<EmployeeLite | null>(null);
  const [messages, setMessages] = useState<EmployeeMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const returnToMailsList = employeeId ? `/employees/${encodeURIComponent(employeeId)}/mails` : '/employees';

  const threads = useMemo(() => (messages ? dedupeLatestByThread(messages) : []), [messages]);

  useEffect(() => {
    if (!token || !employeeId.trim()) return;
    let cancelled = false;
    setError(null);
    setMessages(null);
    setEmployee(null);
    void (async () => {
      const [empRes, msgRes] = await Promise.all([
        apiFetch('/employees', token),
        apiFetch(`/employees/${encodeURIComponent(employeeId)}/messages?limit=40`, token),
      ]);
      if (cancelled) return;
      if (empRes.ok) {
        const rows = (await empRes.json()) as EmployeeLite[];
        setEmployee(Array.isArray(rows) ? rows.find((e) => e.id === employeeId) ?? null : null);
      }
      if (!msgRes.ok) {
        setError(await readApiErrorMessage(msgRes, 'Could not load mail for this mailbox.'));
        setMessages([]);
        return;
      }
      const body = (await msgRes.json()) as { messages?: EmployeeMessage[] };
      setMessages(Array.isArray(body.messages) ? body.messages : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, employeeId]);

  if (authLoading || !me) {
    return (
      <AppShell
        role=""
        companyName={null}
        userDisplayName=""
        title="Mailbox mail"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (!token) {
    router.replace('/auth');
    return null;
  }

  if (!employeeId.trim()) {
    router.replace('/employees');
    return null;
  }

  const title = employee?.name?.trim() || 'Mailbox';
  const subtitle = employee?.email?.trim() ?? employeeId;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title={title}
      subtitle={subtitle}
      onSignOut={() => void ctxSignOut()}
    >
      <div className="mb-6">
        <Link
          href="/employees"
          className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
        >
          ← Back to team
        </Link>
      </div>

      <p className="mb-4 text-sm text-slate-600">
        Recent inbound messages synced for this mailbox, grouped by sender so different clients stay separate. Open a
        thread to read the full message body we store from Gmail (same view as dashboard &quot;Read mail&quot;).
      </p>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : null}

      {messages === null ? <PortalPageLoader variant="embedded" dense /> : null}

      {messages && threads.length === 0 && !error ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600">
          No ingested inbound mail yet for this mailbox. After sync, threads will appear here.
        </p>
      ) : null}

      {messages && threads.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {threads.map((m, idx) => {
            const prev = threads[idx - 1];
            const clientKey = (m.from_email ?? '').trim().toLowerCase();
            const prevKey = idx > 0 ? (prev.from_email ?? '').trim().toLowerCase() : '';
            const showClientBand = idx === 0 || clientKey !== prevKey;
            const conversationId = `${employeeId}:${m.provider_thread_id}`;
            const href = conversationReadPath(conversationId, returnToMailsList);
            return (
              <Fragment key={m.provider_thread_id}>
                {showClientBand ? (
                  <div className="border-b border-slate-200 bg-slate-100 px-4 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">External sender</p>
                    <p className="text-sm font-semibold text-slate-900">{m.from_email || '—'}</p>
                  </div>
                ) : null}
                <Link
                  href={href}
                  className="block border-b border-slate-100 px-4 py-4 transition-colors last:border-b-0 hover:bg-sky-50/50"
                >
                  <p className="font-semibold text-slate-900">{m.subject?.trim() || '(no subject)'}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(m.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                  <p className="mt-2 text-xs font-semibold text-brand-600">Open full thread in app →</p>
                </Link>
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </AppShell>
  );
}
