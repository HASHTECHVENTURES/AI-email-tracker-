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
  replies: Array<{ id: string; body: string; created_at: string }>;
};

export default function ManagerMessagesPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [items, setItems] = useState<SentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        replies: x.replies ?? [],
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
      subtitle="Outbound alerts and nudges to your team."
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Replies from teammate</p>
                  <ul className="mt-2 space-y-2">
                    {(a.replies ?? []).map((r) => (
                      <li key={r.id} className="rounded-lg bg-brand-50/80 px-3 py-2 text-sm text-slate-800">
                        <p className="text-xs text-slate-500">{new Date(r.created_at).toLocaleString()}</p>
                        <p className="mt-1 whitespace-pre-wrap">{r.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
