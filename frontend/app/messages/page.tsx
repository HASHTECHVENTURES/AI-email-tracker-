'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage, tryRecoverFromUnauthorized } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { useSupabaseRealtimeRefresh } from '@/lib/use-supabase-realtime-refresh';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';

type Me = {
  role: string;
  company_name?: string | null;
};

type TeamAlertItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  /** Manager user id on root rows — preferred for grouping. */
  from_user_id?: string;
  from_manager_name: string | null;
  from_manager_email: string | null;
  in_reply_to?: string | null;
  is_own_message?: boolean;
};

/** Group separate root alerts from the same manager (same as one chat). */
function rootConversationKey(r: TeamAlertItem): string {
  if (r.from_user_id) return `u:${r.from_user_id}`;
  const e = r.from_manager_email?.trim().toLowerCase();
  if (e) return `m:${e}`;
  return `n:${r.from_manager_name?.trim() || 'manager'}`;
}

function lastActivityMs(root: TeamAlertItem, replies: TeamAlertItem[]): number {
  let t = new Date(root.created_at).getTime();
  for (const rep of replies) {
    t = Math.max(t, new Date(rep.created_at).getTime());
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

export default function MessagesPage() {
  const router = useRouter();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const allowEmployeeMessages =
    !!authMe &&
    (authMe.role === 'EMPLOYEE' ||
      (isDepartmentManagerRole(authMe.role) && !!authMe.linked_employee_id?.trim()));

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    if (authMe.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    if (!allowEmployeeMessages) {
      router.replace('/dashboard');
    }
  }, [authLoading, authMe, token, allowEmployeeMessages, router]);

  if (authLoading || !authMe || !token || !allowEmployeeMessages) {
    return (
      <AppShell role="EMPLOYEE" title="Messages & alerts" subtitle="" onSignOut={() => void ctxSignOut()}>
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  return <MessagesPageInner />;
}

function MessagesPageInner() {
  const router = useRouter();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const me = authMe as Me;
  const [items, setItems] = useState<TeamAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [draftByRoot, setDraftByRoot] = useState<Record<string, string>>({});
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const repliesByParent = useMemo(() => {
    const m = new Map<string, TeamAlertItem[]>();
    for (const i of items) {
      if (i.in_reply_to) {
        const arr = m.get(i.in_reply_to) ?? [];
        arr.push(i);
        m.set(i.in_reply_to, arr);
      }
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return m;
  }, [items]);

  const roots = useMemo(() => items.filter((a) => !a.in_reply_to), [items]);

  /** Multiple root rows from the same manager → one sidebar entry. */
  const byConversation = useMemo(() => {
    const m = new Map<string, TeamAlertItem[]>();
    for (const r of roots) {
      const k = rootConversationKey(r);
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return m;
  }, [roots]);

  const sidebarRows = useMemo(() => {
    return Array.from(byConversation.entries())
      .map(([conversationKey, convRoots]) => {
        const latest = convRoots[convRoots.length - 1];
        const reps = repliesByParent.get(latest.id) ?? [];
        const lastReply = reps[reps.length - 1];
        const preview = (lastReply?.body ?? latest.body).trim();
        const anyUnread = convRoots.some((r) => !r.read_at);
        let sortKey = 0;
        for (const root of convRoots) {
          const rreps = repliesByParent.get(root.id) ?? [];
          sortKey = Math.max(sortKey, lastActivityMs(root, rreps));
        }
        return {
          conversationKey,
          latestRootId: latest.id,
          managerLabel: latest.from_manager_name?.trim() || 'Manager',
          managerEmail: latest.from_manager_email ?? '',
          preview,
          sortKey,
          anyUnread,
        };
      })
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [byConversation, repliesByParent]);
  const filteredSidebarRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sidebarRows;
    return sidebarRows.filter(
      (row) =>
        row.managerLabel.toLowerCase().includes(q) ||
        row.managerEmail.toLowerCase().includes(q) ||
        row.preview.toLowerCase().includes(q),
    );
  }, [sidebarRows, searchQuery]);

  const firstLatestRootId = sidebarRows[0]?.latestRootId ?? null;

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/team-alerts/mine', token);
    if (!res.ok) {
      if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
      setError(await readApiErrorMessage(res, 'Could not load your messages.'));
      setItems([]);
      return;
    }
    const body = (await res.json()) as { items?: TeamAlertItem[] };
    setItems(body.items ?? []);
    setError(null);
  }, [token, ctxSignOut]);

  useRefetchOnFocus(() => void load(), Boolean(token && authMe && !authLoading));

  const messagesRealtimeEnabled =
    !!token &&
    !!authMe &&
    !authLoading &&
    (authMe.role === 'EMPLOYEE' ||
      (isDepartmentManagerRole(authMe.role) && !!authMe.linked_employee_id?.trim()));

  useSupabaseRealtimeRefresh({
    enabled: messagesRealtimeEnabled,
    channelSuffix: 'employee-messages',
    tables: [{ table: 'team_alerts' }],
    onSignal: () => void load(),
    debounceMs: 450,
  });

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    if (authMe.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    const allowEmployeeMessages =
      authMe.role === 'EMPLOYEE' ||
      (isDepartmentManagerRole(authMe.role) && !!authMe.linked_employee_id?.trim());
    if (!allowEmployeeMessages) {
      router.replace('/dashboard');
      return;
    }
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [authLoading, authMe, token, router, load]);

  useEffect(() => {
    if (!roots.length) {
      setActiveThreadId(null);
      return;
    }
    if (!activeThreadId || !roots.some((r) => r.id === activeThreadId)) {
      setActiveThreadId(firstLatestRootId);
    }
  }, [roots, activeThreadId, firstLatestRootId]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [activeThreadId, items, sendingFor]);

  async function sendReply(parentAlertId: string) {
    const message = draftByRoot[parentAlertId]?.trim() ?? '';
    if (!token || !message) return;
    setSendingFor(parentAlertId);
    try {
      const res = await apiFetch('/team-alerts/reply', token, {
        method: 'POST',
        body: JSON.stringify({ parentAlertId, message }),
      });
      if (!res.ok) {
        if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
        setError(await readApiErrorMessage(res, 'Could not send reply.'));
        return;
      }
      setDraftByRoot((prev) => ({ ...prev, [parentAlertId]: '' }));
      await load();
    } finally {
      setSendingFor(null);
    }
  }

  async function dismiss(id: string) {
    if (!token) return;
    const res = await apiFetch(`/team-alerts/read/${encodeURIComponent(id)}`, token, {
      method: 'PATCH',
    });
    if (!res.ok) {
      if (await tryRecoverFromUnauthorized(res, ctxSignOut)) return;
      setError(await readApiErrorMessage(res, 'Could not dismiss this message.'));
      return;
    }
    await load();
  }

  const rootMessageCount = roots.length;
  const unreadConversationCount = sidebarRows.filter((r) => r.anyUnread).length;
  const activeRoot = roots.find((r) => r.id === activeThreadId) ?? null;
  const rootsForActiveConversation = activeRoot
    ? (byConversation.get(rootConversationKey(activeRoot)) ?? []).slice()
    : [];
  const anyUnreadInConversation = rootsForActiveConversation.some((r) => !r.read_at);
  const latestRoot = rootsForActiveConversation.length
    ? rootsForActiveConversation[rootsForActiveConversation.length - 1]
    : null;
  const flattenedMessages = useMemo(() => {
    const rows: Array<{
      id: string;
      body: string;
      createdAt: string;
      mine: boolean;
      deliveryLabel?: string;
    }> = [];
    for (const root of rootsForActiveConversation) {
      rows.push({
        id: root.id,
        body: root.body,
        createdAt: root.created_at,
        mine: false,
        deliveryLabel: root.read_at ? 'Read' : 'Unread',
      });
      for (const reply of repliesByParent.get(root.id) ?? []) {
        const mine = reply.is_own_message === true;
        rows.push({
          id: reply.id,
          body: reply.body,
          createdAt: reply.created_at,
          mine,
          deliveryLabel: mine ? 'Sent' : undefined,
        });
      }
    }
    rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return rows;
  }, [rootsForActiveConversation, repliesByParent]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
  }, [latestRoot?.id]);

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={authMe?.full_name?.trim() || authMe?.email}
      title="Messages"
      subtitle="Messages from your manager. New items also appear on your dashboard until dismissed."
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <PortalPageLoader variant="embedded" dense />
      ) : (
        <section id="manager-alerts-new" className="grid gap-4 scroll-mt-24 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-2xl border border-slate-200/70 bg-white shadow-card">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Messages</p>
                {unreadConversationCount > 0 ? (
                  <span
                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900"
                    title="Chats with something you have not dismissed yet"
                  >
                    {unreadConversationCount}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">From your manager</p>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats"
                className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none ring-brand-500 placeholder:text-slate-400 focus:ring-1"
              />
            </div>
            <ul className="max-h-[64vh] overflow-y-auto p-2">
              {filteredSidebarRows.map((row) => {
                const convRoots = byConversation.get(row.conversationKey) ?? [];
                const activeRow =
                  (activeRoot && rootConversationKey(activeRoot) === row.conversationKey) ||
                  row.latestRootId === activeThreadId;
                const unreadCount = convRoots.filter((r) => !r.read_at).length;
                return (
                  <li key={row.conversationKey}>
                    <button
                      type="button"
                      onClick={() => setActiveThreadId(row.latestRootId)}
                      className={`w-full rounded-xl px-3 py-2 text-left ${
                        activeRow ? 'bg-indigo-50 ring-1 ring-indigo-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-slate-900">{row.managerLabel}</p>
                        {unreadCount > 0 ? (
                          <span className="shrink-0 rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-white">
                            {unreadCount}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-slate-500">{row.managerEmail}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-600">{row.preview || '(no message)'}</p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {convRoots.length > 1 && activeRow ? `${convRoots.length} messages · ` : null}
                        {new Date(row.sortKey).toLocaleString()}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="rounded-2xl border border-slate-200/70 bg-white shadow-card">
            {activeRoot ? (
              <>
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{activeRoot.from_manager_name?.trim() || 'Manager'}</p>
                    <p className="text-xs text-slate-500">{activeRoot.from_manager_email ?? ''}</p>
                  </div>
                  {anyUnreadInConversation ? (
                    <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">New</span>
                  ) : null}
                </header>

                <div
                  ref={chatScrollRef}
                  className="max-h-[52vh] space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4"
                >
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
                        <div className={`flex ${msg.mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                              msg.mine ? 'rounded-br-sm bg-indigo-600 text-white' : 'rounded-bl-sm bg-white text-slate-800'
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{msg.body}</p>
                            <div className={`mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px] ${msg.mine ? 'text-indigo-100' : 'text-slate-400'}`}>
                              <span className="tabular-nums opacity-90">{new Date(msg.createdAt).toLocaleString()}</span>
                              {msg.deliveryLabel ? <span className="font-medium">{msg.deliveryLabel}</span> : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {latestRoot ? (
                  <div className="border-t border-slate-100 px-4 py-3">
                    <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
                      {!latestRoot.read_at ? (
                        <button
                          type="button"
                          onClick={() => void dismiss(latestRoot.id)}
                          disabled={sendingFor === latestRoot.id}
                          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      ) : null}
                    </div>
                    <div className="flex items-end gap-2">
                      <textarea
                        ref={composerRef}
                        id={`employee-reply-${latestRoot.id}`}
                        rows={1}
                        value={draftByRoot[latestRoot.id] ?? ''}
                        onChange={(e) =>
                          {
                            setDraftByRoot((prev) => ({ ...prev, [latestRoot.id]: e.target.value }));
                            e.currentTarget.style.height = 'auto';
                            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 180)}px`;
                          }
                        }
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          if (e.shiftKey) return;
                          e.preventDefault();
                          if (sendingFor === latestRoot.id) return;
                          void sendReply(latestRoot.id);
                        }}
                        disabled={sendingFor === latestRoot.id}
                        placeholder="Type your reply"
                        className="min-h-[44px] w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                      />
                      <button
                        type="button"
                        onClick={() => void sendReply(latestRoot.id)}
                        disabled={
                          sendingFor === latestRoot.id ||
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
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                {rootMessageCount === 0
                  ? 'Nothing here yet. When your manager sends a message, it will appear here.'
                  : 'Select a thread to view messages.'}
              </div>
            )}
          </div>
        </section>
      )}
    </AppShell>
  );
}
