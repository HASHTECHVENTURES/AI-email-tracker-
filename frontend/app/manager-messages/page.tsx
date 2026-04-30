'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
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

type ReceivedItem = {
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

function lastActivityMs(thread: SentItem): number {
  let t = new Date(thread.created_at).getTime();
  for (const r of thread.replies ?? []) {
    t = Math.max(t, new Date(r.created_at).getTime());
  }
  return t;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dateSeparatorLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, now)) return 'Today';
  if (isSameCalendarDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString();
}

export default function ManagerMessagesPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [items, setItems] = useState<SentItem[]>([]);
  const [receivedItems, setReceivedItems] = useState<ReceivedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftByRoot, setDraftByRoot] = useState<Record<string, string>>({});
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const [res, receivedRes] = await Promise.all([
      apiFetch('/team-alerts/sent', token),
      me?.linked_employee_id?.trim()
        ? apiFetch('/team-alerts/mine', token)
        : Promise.resolve({ ok: false } as Response),
    ]);
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not load conversations.'));
      setItems([]);
      setReceivedItems([]);
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
    if (receivedRes.ok) {
      const receivedBody = (await receivedRes.json()) as { items?: ReceivedItem[] };
      setReceivedItems(receivedBody.items ?? []);
    } else {
      setReceivedItems([]);
    }
    setError(null);
  }, [me?.linked_employee_id, token]);

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
  const filteredSidebarRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sidebarRows;
    return sidebarRows.filter(
      (row) =>
        row.employee_name.toLowerCase().includes(q) ||
        row.employee_email.toLowerCase().includes(q) ||
        row.preview.toLowerCase().includes(q),
    );
  }, [sidebarRows, searchQuery]);
  const receivedRoots = useMemo(
    () =>
      receivedItems
        .filter((i) => !i.in_reply_to)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [receivedItems],
  );

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

  const flattenedMessages = useMemo(() => {
    const rows: Array<{
      id: string;
      body: string;
      createdAt: string;
      fromManager: boolean;
      deliveryLabel?: string;
    }> = [];
    for (const root of rootsForActiveEmployee) {
      rows.push({
        id: root.id,
        body: root.body,
        createdAt: root.created_at,
        fromManager: true,
        deliveryLabel: root.read_at ? 'Seen' : 'Delivered',
      });
      for (const reply of root.replies ?? []) {
        rows.push({
          id: reply.id,
          body: reply.body,
          createdAt: reply.created_at,
          fromManager: reply.from_manager,
          deliveryLabel: reply.from_manager ? 'Sent' : undefined,
        });
      }
    }
    rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return rows;
  }, [rootsForActiveEmployee]);

  const latestDraft = latestRoot ? draftByRoot[latestRoot.id] ?? '' : '';
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [latestDraft, latestRoot?.id]);

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
      <AppShell role="HEAD" title="Messages & alerts" subtitle="" onSignOut={() => void ctxSignOut()}>
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title="Messages & alerts"
      subtitle="One place for team conversations and alerts."
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Chat workspace
        </p>
        <Link
          href="/departments#team-members"
          className="inline-flex rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95"
        >
          New alert
        </Link>
      </div>

      {loading ? (
        <PortalPageLoader variant="embedded" dense />
      ) : (
        <section className="overflow-hidden rounded-3xl border border-slate-200/70 bg-white shadow-card">
          <div className="grid min-h-[72vh] lg:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="border-r border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">Chats</p>
                  {awaitingCount > 0 ? (
                    <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
                      {awaitingCount}
                    </span>
                  ) : null}
                </div>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search chats"
                  className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none ring-brand-500 placeholder:text-slate-400 focus:ring-1"
                />
              </div>

              <div className="max-h-[72vh] overflow-y-auto">
                {filteredSidebarRows.length === 0 && receivedRoots.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-slate-500">No chats yet. Start with “New alert”.</div>
                ) : null}

                <ul className="space-y-1 p-2">
                  {filteredSidebarRows.map((row) => {
                    const rowRoots = byEmployee.get(row.employeeId) ?? [];
                    const activeRow =
                      activeSent?.employee_id === row.employeeId || row.latestRootId === activeThreadId;
                    const unreadCount = rowRoots.filter((r) => !r.read_at).length;
                    return (
                      <li key={row.employeeId}>
                        <button
                          type="button"
                          onClick={() => setActiveThreadId(row.latestRootId)}
                          className={`w-full rounded-xl px-3 py-2 text-left ${
                            activeRow ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-900">{row.employee_name}</p>
                              <p className="truncate text-xs text-slate-500">{row.employee_email}</p>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <p className="text-[10px] text-slate-400">
                                {new Date(row.sortKey).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </p>
                              {unreadCount > 0 ? (
                                <span className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-white">
                                  {unreadCount}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-600">
                            {rowRoots.length > 1 && activeRow ? `${rowRoots.length} alerts · ` : null}
                            {row.preview || '(no message)'}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {receivedRoots.length > 0 ? (
                  <div className="border-t border-slate-100 px-3 pb-3 pt-2">
                    <p className="px-1 py-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                      Messages to you
                    </p>
                    <div className="space-y-2">
                      {receivedRoots.slice(0, 5).map((msg) => (
                        <div key={msg.id} className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
                          <p className="truncate text-xs font-semibold text-amber-950">
                            From {msg.from_manager_name?.trim() || 'your manager'}
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-amber-900">{msg.body}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </aside>

            <div className="flex min-h-0 flex-col bg-[#efeae2]/70">
              {activeSent ? (
                <>
                  <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
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

                  <div ref={chatScrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                    {flattenedMessages.map((msg, idx) => {
                      const prev = idx > 0 ? flattenedMessages[idx - 1] : null;
                      const showDateSeparator =
                        !prev || !isSameCalendarDay(new Date(prev.createdAt), new Date(msg.createdAt));
                      return (
                        <div key={msg.id} className="space-y-2">
                          {showDateSeparator ? (
                            <div className="sticky top-1 z-10 flex justify-center">
                              <span className="rounded-full border border-slate-200 bg-white/95 px-2 py-0.5 text-[10px] font-medium text-slate-500 shadow-sm backdrop-blur">
                                {dateSeparatorLabel(msg.createdAt)}
                              </span>
                            </div>
                          ) : null}
                          <div className={`flex ${msg.fromManager ? 'justify-end' : 'justify-start'}`}>
                            <div
                              className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                                msg.fromManager
                                  ? 'rounded-br-sm bg-emerald-600 text-white'
                                  : 'rounded-bl-sm bg-white text-slate-800'
                              }`}
                            >
                              <p className="whitespace-pre-wrap">{msg.body}</p>
                              <div className={`mt-1 flex justify-end gap-2 text-[10px] ${msg.fromManager ? 'text-emerald-100' : 'text-slate-400'}`}>
                                <span>{new Date(msg.createdAt).toLocaleString()}</span>
                                {msg.deliveryLabel ? <span>{msg.deliveryLabel}</span> : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {latestRoot ? (
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => void removeSent(latestRoot.id)}
                          disabled={deletingId === latestRoot.id}
                          className="text-[11px] font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                        >
                          {deletingId === latestRoot.id ? 'Deleting…' : 'Delete latest alert'}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {latestRoot ? (
                    <div className="border-t border-slate-200 bg-white px-3 py-3">
                      <div className="flex items-end gap-2">
                        <textarea
                          ref={composerRef}
                          id={`mgr-reply-${latestRoot.id}`}
                          rows={1}
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
                          placeholder="Type a message"
                          className="min-h-[44px] w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                        />
                        <button
                          type="button"
                          onClick={() => void sendManagerReply(latestRoot.id)}
                          disabled={
                            sendingFor === latestRoot.id ||
                            deletingId === latestRoot.id ||
                            !(draftByRoot[latestRoot.id]?.trim())
                          }
                          className="h-11 shrink-0 rounded-2xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 text-xs font-semibold text-white hover:opacity-95 disabled:opacity-50"
                        >
                          {sendingFor === latestRoot.id ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <p className="max-w-sm text-sm text-slate-600">
                    Select a chat from the left to start messaging in this workspace.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </AppShell>
  );
}
