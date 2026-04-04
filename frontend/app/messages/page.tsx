'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildManagerReplyMailto } from '@/lib/managerReplyMailto';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

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
};

export default function MessagesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<TeamAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const unread = items.filter((a) => !a.read_at);
  const read = items.filter((a) => a.read_at);

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Messages & alerts"
      subtitle="Manager notes and alerts in one place. New items also appear on your dashboard until you dismiss them here."
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-8">
          <section id="manager-alerts-new" className="scroll-mt-24 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">New</h2>
            {unread.length > 0 ? (
              unread.map((a) => {
                const replyHref = buildManagerReplyMailto(a.from_manager_email, a.body);
                return (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm shadow-sm sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="mt-1 whitespace-pre-wrap text-gray-800">{a.body}</p>
                    <p className="mt-2 text-xs text-gray-500">
                      From {a.from_manager_name?.trim() || 'Your manager'} · {new Date(a.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                    {replyHref ? (
                      <a
                        href={replyHref}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-center text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                      >
                        Reply
                      </a>
                    ) : (
                      <span className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-400" title="Manager email not available">
                        Reply
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void dismiss(a.id)}
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-950 transition hover:bg-amber-100"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                );
              })
            ) : (
              <div className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-600 shadow-sm">
                {read.length === 0 && items.length === 0
                  ? 'Nothing here yet. When your manager sends a message or alert, it will show in this list.'
                  : 'No new items — you’re caught up.'}
              </div>
            )}
          </section>

          {read.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Earlier</h2>
              {read.map((a) => {
                const replyHref = buildManagerReplyMailto(a.from_manager_email, a.body);
                return (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 shadow-sm sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap">{a.body}</p>
                    <p className="mt-2 text-xs text-gray-500">
                      From {a.from_manager_name?.trim() || 'Your manager'} · {new Date(a.created_at).toLocaleString()}
                    </p>
                  </div>
                  {replyHref ? (
                    <a
                      href={replyHref}
                      className="shrink-0 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-900 transition hover:bg-blue-50"
                    >
                      Reply
                    </a>
                  ) : null}
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
