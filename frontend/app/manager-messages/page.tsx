'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import Link from 'next/link';

type Me = {
  role: string;
  company_name?: string | null;
};

type SentItem = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  employee_id: string;
  employee_name: string;
  employee_email: string;
};

export default function ManagerMessagesPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<SentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch('/team-alerts/sent', session.access_token);
    if (!res.ok) {
      setError('Could not load sent messages.');
      setItems([]);
      return;
    }
    const body = (await res.json()) as { items?: SentItem[] };
    setItems(body.items ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return router.replace('/auth');
      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) return router.replace('/auth');
      const m = (await meRes.json()) as Me;
      if (m.role !== 'HEAD' && m.role !== 'MANAGER') {
        router.replace('/dashboard');
        return;
      }
      setMe(m);
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [router, load]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  if (!me) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Messages"
      subtitle="Alerts you’ve sent to your team. Use Alerts in the sidebar to send a new one."
      onSignOut={() => void signOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="mb-4">
        <Link
          href="/departments#team-members"
          className="inline-flex rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-700"
        >
          Send new alert
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <section className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-gray-600">
            No messages sent yet. Use <span className="font-medium text-gray-800">Alerts</span> in the sidebar, then pick a team member on My department.
          </p>
        </section>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li
              key={a.id}
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                To {a.employee_name}{' '}
                <span className="font-normal normal-case text-gray-400">({a.employee_email})</span>
              </p>
              <p className="mt-2 whitespace-pre-wrap text-gray-800">{a.body}</p>
              <p className="mt-2 text-xs text-gray-500">
                Sent {new Date(a.created_at).toLocaleString()}
                {a.read_at ? (
                  <span className="text-emerald-700"> · Seen {new Date(a.read_at).toLocaleString()}</span>
                ) : (
                  <span className="text-amber-700"> · Not dismissed yet</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
