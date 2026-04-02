'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

type Me = {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  company_name?: string | null;
  role: string;
  department_id: string | null;
};

type AiReport = {
  created_at: string;
  generated_at: string;
  key_issues: string[];
  employee_insights: string[];
  patterns: string[];
  recommendation: string;
};

export default function AiReportsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [reports, setReports] = useState<AiReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  async function loadData(token: string) {
    const [sysRes, repRes] = await Promise.all([
      apiFetch('/system/status', token),
      apiFetch('/dashboard/ai-reports?limit=100', token),
    ]);
    if (sysRes.ok) {
      const s = await sysRes.json();
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
    }
    if (repRes.ok) {
      const body = (await repRes.json()) as { items?: AiReport[] };
      setReports(body.items ?? []);
    } else {
      setError('Could not load AI reports.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/auth');
        return;
      }
      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) {
        if (meRes.status === 401) {
          await supabase.auth.signOut();
          router.replace('/auth');
          return;
        }
        setError('Could not load profile.');
        return;
      }
      const user = (await meRes.json()) as Me;
      if (cancelled) return;
      if (user.role === 'EMPLOYEE') {
        router.replace('/dashboard');
        return;
      }
      setMe(user);
      await loadData(session.access_token);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">{error ?? 'Loading...'}</div>;
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="AI Reports"
      subtitle={
        isHead
          ? 'Department-only AI briefings: coaching, clients, and team actions for your unit. Separate from the CEO executive report.'
          : 'Executive company-wide briefings (aggregated strategy). Managers have their own department report stream.'
      }
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      onRefresh={() => {
        void (async () => {
          const supabase = createClient();
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session) await loadData(session.access_token);
        })();
      }}
      onSignOut={() => void signOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {reports.length === 0 ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">
            No archived AI reports yet. Reports are generated approximately every 1 hour.
          </p>
        </section>
      ) : (
        <section className="space-y-4">
          {reports.map((r, idx) => (
            <article key={`${r.created_at}-${idx}`} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">
                  Report #{reports.length - idx}
                </h3>
                <p className="text-xs text-gray-500">
                  {new Date(r.generated_at || r.created_at).toLocaleString()}
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Key issues</p>
                  <ul className="list-disc space-y-1 pl-4 text-sm text-gray-700">
                    {(r.key_issues ?? []).length ? (r.key_issues ?? []).map((line, i) => <li key={i}>{line}</li>) : <li>No key issues</li>}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Employee insights</p>
                  <ul className="list-disc space-y-1 pl-4 text-sm text-gray-700">
                    {(r.employee_insights ?? []).length ? (r.employee_insights ?? []).map((line, i) => <li key={i}>{line}</li>) : <li>No employee insights</li>}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Patterns</p>
                  <ul className="list-disc space-y-1 pl-4 text-sm text-gray-700">
                    {(r.patterns ?? []).length ? (r.patterns ?? []).map((line, i) => <li key={i}>{line}</li>) : <li>No patterns</li>}
                  </ul>
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Recommendation</p>
                <p className="mt-1 text-sm text-blue-900">{r.recommendation || 'No recommendation in this report.'}</p>
              </div>
            </article>
          ))}
        </section>
      )}
    </AppShell>
  );
}
