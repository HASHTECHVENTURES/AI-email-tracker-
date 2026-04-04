'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
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
  from_manager_name: string | null;
  from_manager_email: string | null;
  in_reply_to?: string | null;
};

export default function MessagesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<TeamAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyModalParent, setReplyModalParent] = useState<TeamAlertItem | null>(null);

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

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/team-alerts/mine', token);
    if (!res.ok) {
      setError('Could not load messages and alerts.');
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
    if (authMe.role !== 'EMPLOYEE') {
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

  async function dismiss(id: string) {
    if (!token) return;
    const res = await apiFetch(`/team-alerts/read/${encodeURIComponent(id)}`, token, {
      method: 'PATCH',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j.message as string) || 'Could not dismiss');
      return;
    }
    await load();
  }

  if (!me || authLoading) {
    return (
      <AppShell role="EMPLOYEE" title="Messages & alerts" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }

  const unread = items.filter((a) => !a.read_at && !a.in_reply_to);
  const read = items.filter((a) => a.read_at && !a.in_reply_to);
  const rootMessageCount = items.filter((a) => !a.in_reply_to).length;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Messages & alerts"
      subtitle="Manager notes and alerts in one place. New items also appear on your dashboard until you dismiss them here."
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
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-8">
          <section id="manager-alerts-new" className="scroll-mt-24 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">New</h2>
            {unread.length > 0 ? (
              unread.map((a) => {
                const thread = repliesByParent.get(a.id) ?? [];
                return (
                  <div key={a.id} className="space-y-2">
                    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm shadow-sm sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Manager</p>
                        <p className="mt-1 whitespace-pre-wrap text-gray-800">{a.body}</p>
                        <p className="mt-2 text-xs text-gray-500">
                          {a.from_manager_name?.trim() || 'Your manager'} · {new Date(a.created_at).toLocaleString()}
                        </p>
                        {thread.length > 0 ? (
                          <ul className="mt-3 space-y-2 border-t border-amber-200/80 pt-3">
                            {thread.map((r) => (
                              <li key={r.id} className="rounded-lg bg-white/80 px-2 py-2 text-xs text-slate-700">
                                <span className="font-semibold text-brand-700">You</span> ·{' '}
                                {new Date(r.created_at).toLocaleString()}
                                <p className="mt-1 whitespace-pre-wrap text-slate-800">{r.body}</p>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                        <button
                          type="button"
                          onClick={() => setReplyModalParent(a)}
                          className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-center text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismiss(a.id)}
                          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-600 shadow-sm">
                {rootMessageCount === 0
                  ? 'Nothing here yet. When your manager sends a message or alert, it will show in this list.'
                  : 'No new items — you’re caught up.'}
              </div>
            )}
          </section>

          {read.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Earlier</h2>
              {read.map((a) => {
                const thread = repliesByParent.get(a.id) ?? [];
                return (
                  <div
                    key={a.id}
                    className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Manager</p>
                      <p className="mt-1 whitespace-pre-wrap">{a.body}</p>
                      <p className="mt-2 text-xs text-gray-500">
                        {a.from_manager_name?.trim() || 'Your manager'} · {new Date(a.created_at).toLocaleString()}
                      </p>
                      {thread.length > 0 ? (
                        <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                          {thread.map((r) => (
                            <li key={r.id} className="rounded-lg bg-slate-50 px-2 py-2 text-xs">
                              <span className="font-semibold text-brand-700">You</span> ·{' '}
                              {new Date(r.created_at).toLocaleString()}
                              <p className="mt-1 whitespace-pre-wrap text-slate-800">{r.body}</p>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyModalParent(a)}
                      className="shrink-0 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                    >
                      Reply
                    </button>
                  </div>
                );
              })}
            </section>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
