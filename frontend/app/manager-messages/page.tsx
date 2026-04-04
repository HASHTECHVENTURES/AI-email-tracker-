'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import Link from 'next/link';

type SentItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  replies: Array<{ id: string; body: string; created_at: string; from_manager: boolean }>;
};

export default function ManagerMessagesPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [items, setItems] = useState<SentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftByRoot, setDraftByRoot] = useState<Record<string, string>>({});
  const [sendingFor, setSendingFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/team-alerts/sent', token);
    if (!res.ok) {
      setError('Could not load sent messages.');
      setItems([]);
      return;
    }
    const body = (await res.json()) as { items?: SentItem[] };
    setItems(
      (body.items ?? []).map((x) => ({
        ...x,
        replies: (x.replies ?? []).map((r) => ({
          ...r,
          from_manager: r.from_manager === true,
        })),
      })),
    );
    setError(null);
  }, [token]);

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      router.replace('/auth');
      return;
    }
    if (me.role !== 'HEAD' && me.role !== 'MANAGER') {
      router.replace('/dashboard');
      return;
    }
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [authLoading, me, token, router, load]);

  async function sendManagerReply(threadRootId: string) {
    const message = draftByRoot[threadRootId]?.trim() ?? '';
    if (!token || !message) return;
    setSendingFor(threadRootId);
    setError(null);
    try {
      const res = await apiFetch('/team-alerts/reply-manager', token, {
        method: 'POST',
        body: JSON.stringify({ threadRootId, message }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not send reply');
        return;
      }
      setDraftByRoot((prev) => ({ ...prev, [threadRootId]: '' }));
      await load();
    } finally {
      setSendingFor(null);
    }
  }

  async function removeSent(id: string) {
    if (!token) return;
    if (
      !window.confirm(
        'Delete this alert and any teammate replies? They will no longer see it in their history.',
      )
    ) {
      return;
    }
    setDeletingId(id);
    try {
      const res = await apiFetch(`/team-alerts/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j.message as string) || 'Could not delete');
        return;
      }
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell role="HEAD" title="Conversations" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Conversations"
      subtitle="Threads with your team — send alerts and follow up when they reply."
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="mb-6">
        <Link
          href="/departments#team-members"
          className="inline-flex rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95"
        >
          New alert
        </Link>
      </div>

      {loading ? (
        <PageSkeleton />
      ) : items.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-200 bg-surface-card p-10 text-center shadow-card">
          <p className="text-sm text-slate-600">Nothing sent yet. Open <span className="font-semibold text-slate-800">Alerts</span> and pick a teammate.</p>
        </section>
      ) : (
        <ul className="space-y-4">
          {items.map((a) => (
            <li
              key={a.id}
              className="rounded-2xl border border-slate-200/60 bg-surface-card p-5 text-sm shadow-card"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {a.employee_name}{' '}
                <span className="font-normal normal-case text-slate-500">· {a.employee_email}</span>
              </p>
              <p className="mt-3 whitespace-pre-wrap text-slate-800">{a.body}</p>
              <p className="mt-3 text-xs text-slate-500">
                {new Date(a.created_at).toLocaleString()}
                {a.read_at ? (
                  <span className="text-emerald-700"> · Seen</span>
                ) : (
                  <span className="text-amber-700"> · Awaiting</span>
                )}
              </p>
              {(a.replies ?? []).length > 0 ? (
                <div className="mt-4 border-t border-slate-200 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Thread</p>
                  <ul className="mt-2 space-y-2">
                    {(a.replies ?? []).map((r) => (
                      <li
                        key={r.id}
                        className={`rounded-lg px-3 py-2 text-sm ${
                          r.from_manager ? 'bg-slate-100 text-slate-800' : 'bg-brand-50/80 text-slate-800'
                        }`}
                      >
                        <p className="text-xs font-semibold text-slate-600">
                          {r.from_manager ? 'You' : a.employee_name} ·{' '}
                          <span className="font-normal text-slate-500">
                            {new Date(r.created_at).toLocaleString()}
                          </span>
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">{r.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mt-4 border-t border-slate-200 pt-3">
                <label htmlFor={`mgr-reply-${a.id}`} className="text-xs font-semibold text-slate-600">
                  Your reply
                </label>
                <textarea
                  id={`mgr-reply-${a.id}`}
                  rows={3}
                  value={draftByRoot[a.id] ?? ''}
                  onChange={(e) => setDraftByRoot((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  disabled={sendingFor === a.id || deletingId === a.id}
                  placeholder="Follow up in this thread…"
                  className="mt-1 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void sendManagerReply(a.id)}
                    disabled={
                      sendingFor === a.id ||
                      deletingId === a.id ||
                      !(draftByRoot[a.id]?.trim())
                    }
                    className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                  >
                    {sendingFor === a.id ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => void removeSent(a.id)}
                  disabled={deletingId === a.id}
                  className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                >
                  {deletingId === a.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
