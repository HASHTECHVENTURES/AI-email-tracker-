'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch, readActAsEmployeeViewEnabled, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { TeamAlertReplyModal } from '@/components/TeamAlertReplyModal';

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

export default function MessagesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<TeamAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyModalParent, setReplyModalParent] = useState<TeamAlertItem | null>(null);
  const [deletingAlertId, setDeletingAlertId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

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

  const firstLatestRootId = sidebarRows[0]?.latestRootId ?? null;

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/team-alerts/mine', token);
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not load your messages.'));
      setItems([]);
      return;
    }
    const body = (await res.json()) as { items?: TeamAlertItem[] };
    setItems(body.items ?? []);
    setError(null);
  }, [token]);

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
      (isDepartmentManagerRole(authMe.role) &&
        !!authMe.linked_employee_id?.trim() &&
        readActAsEmployeeViewEnabled());
    if (!allowEmployeeMessages) {
      router.replace('/dashboard');
      return;
    }
    setMe(authMe as Me);
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [authLoading, authMe, token, router, load]);

  useEffect(() => {
    if (pathname !== '/messages') return;
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#manager-alerts-new') return;
    const el = document.getElementById('manager-alerts-new');
    if (!el) return;
    const t = window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => window.clearTimeout(t);
  }, [pathname, items.length, loading]);

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
  }, [activeThreadId, items, deletingAlertId]);

  async function dismiss(id: string) {
    if (!token) return;
    const res = await apiFetch(`/team-alerts/read/${encodeURIComponent(id)}`, token, {
      method: 'PATCH',
    });
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not dismiss this message.'));
      return;
    }
    await load();
  }

  async function removeAlert(id: string) {
    if (!token) return;
    if (!window.confirm('Delete this manager message and any replies? This cannot be undone.')) return;
    setDeletingAlertId(id);
    try {
      const res = await apiFetch(`/team-alerts/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not delete this message.'));
        return;
      }
      setReplyModalParent((p) => (p?.id === id ? null : p));
      await load();
    } finally {
      setDeletingAlertId(null);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell role="EMPLOYEE" title="Messages & alerts" subtitle="" onSignOut={() => void ctxSignOut()}>
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  const rootMessageCount = roots.length;
  const unreadConversationCount = sidebarRows.filter((r) => r.anyUnread).length;
  const activeRoot = roots.find((r) => r.id === activeThreadId) ?? null;
  const rootsForActiveConversation = activeRoot
    ? (byConversation.get(rootConversationKey(activeRoot)) ?? []).slice()
    : [];
  const anyUnreadInConversation = rootsForActiveConversation.some((r) => !r.read_at);

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={authMe?.full_name?.trim() || authMe?.email}
      title="Messages"
      subtitle="Messages from your manager. New items also appear on your dashboard until dismissed."
      onSignOut={() => void ctxSignOut()}
    >
      {token ? (
        <TeamAlertReplyModal
          open={replyModalParent != null}
          parent={replyModalParent}
          token={token}
          onClose={() => setReplyModalParent(null)}
          onSent={() => void load()}
        />
      ) : null}
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
            </div>
            <ul className="max-h-[64vh] overflow-y-auto p-2">
              {sidebarRows.map((row) => {
                const convRoots = byConversation.get(row.conversationKey) ?? [];
                const activeRow =
                  (activeRoot && rootConversationKey(activeRoot) === row.conversationKey) ||
                  row.latestRootId === activeThreadId;
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
                        {row.anyUnread ? (
                          <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900">
                            New
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
                  {rootsForActiveConversation.map((root, idx) => {
                    const threadReplies = repliesByParent.get(root.id) ?? [];
                    return (
                      <div key={root.id} className="space-y-3">
                        {idx > 0 ? (
                          <p className="text-center text-[10px] font-medium uppercase tracking-wide text-slate-400">
                            Earlier · {new Date(root.created_at).toLocaleString()}
                          </p>
                        ) : null}
                        <div className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl bg-white px-3 py-2 text-sm text-slate-800 shadow-sm">
                            <p className="whitespace-pre-wrap">{root.body}</p>
                            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                              <span className="tabular-nums">{new Date(root.created_at).toLocaleString()}</span>
                              <span className="font-medium text-slate-500">{root.read_at ? 'Read' : 'Unread'}</span>
                            </div>
                          </div>
                        </div>
                        {threadReplies.map((r) => {
                          const mine = r.is_own_message === true;
                          return (
                            <div key={r.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                              <div
                                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                                  mine ? 'bg-indigo-600 text-white' : 'bg-white text-slate-800'
                                }`}
                              >
                                <p className="whitespace-pre-wrap">{r.body}</p>
                                <div
                                  className={`mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px] ${
                                    mine ? 'text-indigo-100' : 'text-slate-400'
                                  }`}
                                >
                                  <span className="tabular-nums opacity-90">{new Date(r.created_at).toLocaleString()}</span>
                                  {mine ? (
                                    <span className="font-medium">Sent</span>
                                  ) : (
                                    <span className="text-slate-500">Manager</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setReplyModalParent(root)}
                            disabled={deletingAlertId === root.id}
                            className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-900 hover:bg-blue-50 disabled:opacity-50"
                            title="Enter sends in the reply window"
                          >
                            Reply
                          </button>
                          {!root.read_at ? (
                            <button
                              type="button"
                              onClick={() => void dismiss(root.id)}
                              disabled={deletingAlertId === root.id}
                              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-50"
                            >
                              Dismiss
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void removeAlert(root.id)}
                            disabled={deletingAlertId === root.id}
                            className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            {deletingAlertId === root.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
