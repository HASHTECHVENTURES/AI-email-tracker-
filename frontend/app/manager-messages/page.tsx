'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
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

function lastActivityMs(thread: SentItem): number {
  let t = new Date(thread.created_at).getTime();
  for (const r of thread.replies ?? []) {
    t = Math.max(t, new Date(r.created_at).getTime());
  }
  return t;
}

export default function ManagerMessagesPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [items, setItems] = useState<SentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftByRoot, setDraftByRoot] = useState<Record<string, string>>({});
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/team-alerts/sent', token);
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not load conversations.'));
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
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (!isDepartmentManagerRole(me.role)) {
      router.replace('/dashboard');
      return;
    }
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [authLoading, me, token, router, load]);

  /** One sidebar row per teammate — multiple root alerts to the same employee are merged here. */
  const byEmployee = useMemo(() => {
    const m = new Map<string, SentItem[]>();
    for (const t of items) {
      const arr = m.get(t.employee_id) ?? [];
      arr.push(t);
      m.set(t.employee_id, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return m;
  }, [items]);

  const sidebarRows = useMemo(() => {
    return Array.from(byEmployee.entries())
      .map(([employeeId, roots]) => {
        const latest = roots[roots.length - 1];
        const lastReply = latest.replies[latest.replies.length - 1];
        const preview = (lastReply?.body ?? latest.body).trim();
        const anyUnread = roots.some((r) => !r.read_at);
        let sortKey = 0;
        for (const root of roots) {
          sortKey = Math.max(sortKey, lastActivityMs(root));
        }
        return {
          employeeId,
          employee_name: latest.employee_name,
          employee_email: latest.employee_email,
          latestRootId: latest.id,
          preview,
          sortKey,
          anyUnread,
        };
      })
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [byEmployee]);

  const firstLatestRootId = sidebarRows[0]?.latestRootId ?? null;

  useEffect(() => {
    if (!items.length) {
      setActiveThreadId(null);
      return;
    }
    if (!activeThreadId || !items.some((i) => i.id === activeThreadId)) {
      setActiveThreadId(firstLatestRootId);
    }
  }, [items, activeThreadId, firstLatestRootId]);

  const awaitingCount = sidebarRows.filter((r) => r.anyUnread).length;

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [activeThreadId, items, sendingFor]);

  const activeSent = useMemo(
    () => items.find((i) => i.id === activeThreadId) ?? null,
    [items, activeThreadId],
  );

  const rootsForActiveEmployee = useMemo(() => {
    if (!activeSent) return [];
    return (byEmployee.get(activeSent.employee_id) ?? []).slice();
  }, [activeSent, byEmployee]);

  const latestRoot = useMemo(() => {
    const r = rootsForActiveEmployee;
    return r.length ? r[r.length - 1] : null;
  }, [rootsForActiveEmployee]);

  const anyUnreadInEmployee = useMemo(
    () => rootsForActiveEmployee.some((row) => !row.read_at),
    [rootsForActiveEmployee],
  );

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
        setError(await readApiErrorMessage(res, 'Could not send your reply.'));
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
        setError(await readApiErrorMessage(res, 'Could not delete this conversation.'));
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
      userDisplayName={me.full_name?.trim() || me.email}
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
        <section className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-2xl border border-slate-200/70 bg-white shadow-card">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Threads</p>
                {awaitingCount > 0 ? (
                  <span
                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900"
                    title="Threads not yet seen by teammate"
                  >
                    {awaitingCount}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">Pick a teammate conversation</p>
            </div>
            <ul className="max-h-[64vh] overflow-y-auto p-2">
              {sidebarRows.map((row) => {
                const rowRoots = byEmployee.get(row.employeeId) ?? [];
                const activeRow =
                  activeSent?.employee_id === row.employeeId || row.latestRootId === activeThreadId;
                return (
                  <li key={row.employeeId}>
                    <button
                      type="button"
                      onClick={() => setActiveThreadId(row.latestRootId)}
                      className={`w-full rounded-xl px-3 py-2 text-left ${
                        activeRow
                          ? 'bg-indigo-50 ring-1 ring-indigo-100'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-slate-900">{row.employee_name}</p>
                        {row.anyUnread ? (
                          <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900">
                            Awaiting
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-slate-500">{row.employee_email}</p>
                      <p className="mt-1 truncate text-xs text-slate-600">{row.preview || '(no message)'}</p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {rowRoots.length > 1 && activeRow ? `${rowRoots.length} alerts · ` : null}
                        {new Date(row.sortKey).toLocaleString()}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="rounded-2xl border border-slate-200/70 bg-white shadow-card">
            {activeSent ? (
              <>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{activeSent.employee_name}</p>
                    <p className="text-xs text-slate-500">{activeSent.employee_email}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                      anyUnreadInEmployee ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {anyUnreadInEmployee ? 'Awaiting' : 'Seen'}
                  </span>
                </header>

                <div
                  ref={chatScrollRef}
                  className="max-h-[52vh] space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4"
                >
                  {rootsForActiveEmployee.map((root, idx) => (
                    <div key={root.id} className="space-y-3">
                      {idx > 0 ? (
                        <p className="text-center text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          Earlier · {new Date(root.created_at).toLocaleString()}
                        </p>
                      ) : null}
                      <div className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl bg-indigo-600 px-3 py-2 text-sm text-white shadow-sm">
                          <p className="whitespace-pre-wrap">{root.body}</p>
                          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px] text-indigo-100">
                            <span className="tabular-nums opacity-90">
                              {new Date(root.created_at).toLocaleString()}
                            </span>
                            <span className="font-medium opacity-95">
                              {root.read_at ? 'Seen' : 'Delivered'}
                            </span>
                          </div>
                        </div>
                      </div>
                      {(root.replies ?? []).map((r) => (
                        <div key={r.id} className={`flex ${r.from_manager ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                              r.from_manager ? 'bg-indigo-600 text-white' : 'bg-white text-slate-800'
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{r.body}</p>
                            <div
                              className={`mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px] ${
                                r.from_manager ? 'text-indigo-100' : 'text-slate-400'
                              }`}
                            >
                              <span className="tabular-nums opacity-90">
                                {new Date(r.created_at).toLocaleString()}
                              </span>
                              {r.from_manager ? (
                                <span className="font-medium opacity-95">Sent</span>
                              ) : (
                                <span className="text-slate-500">Reply</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void removeSent(root.id)}
                          disabled={deletingId === root.id}
                          className="text-[11px] font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                        >
                          {deletingId === root.id ? 'Deleting…' : 'Delete this alert'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {latestRoot ? (
                  <div className="border-t border-slate-100 px-4 py-3">
                    <label htmlFor={`mgr-reply-${latestRoot.id}`} className="text-xs font-semibold text-slate-600">
                      Your reply
                    </label>
                    <textarea
                      id={`mgr-reply-${latestRoot.id}`}
                      rows={3}
                      value={draftByRoot[latestRoot.id] ?? ''}
                      onChange={(e) =>
                        setDraftByRoot((prev) => ({ ...prev, [latestRoot.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        if (e.shiftKey) return;
                        e.preventDefault();
                        if (sendingFor === latestRoot.id || deletingId === latestRoot.id) return;
                        void sendManagerReply(latestRoot.id);
                      }}
                      disabled={sendingFor === latestRoot.id || deletingId === latestRoot.id}
                      placeholder="Type your message… (Enter to send, Shift+Enter for new line)"
                      className="mt-1 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                    />
                    <p className="mt-1 text-[11px] text-slate-400">Enter sends · Shift+Enter new line</p>
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void sendManagerReply(latestRoot.id)}
                        disabled={
                          sendingFor === latestRoot.id ||
                          deletingId === latestRoot.id ||
                          !(draftByRoot[latestRoot.id]?.trim())
                        }
                        className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                      >
                        {sendingFor === latestRoot.id ? 'Sending…' : 'Send'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      )}
    </AppShell>
  );
}
