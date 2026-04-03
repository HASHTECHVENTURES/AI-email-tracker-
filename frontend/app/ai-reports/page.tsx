'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

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

function SectionCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-slate-800">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm ring-1 ring-slate-100">
          {icon}
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="text-sm text-slate-600">{children}</div>
    </div>
  );
}

export default function AiReportsPage() {
  const router = useRouter();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [reports, setReports] = useState<AiReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [aiBriefingsOn, setAiBriefingsOn] = useState(true);
  const [mailboxCrawlOn, setMailboxCrawlOn] = useState(true);

  async function loadData(token: string) {
    const [sysRes, repRes] = await Promise.all([
      apiFetch('/system/status', token),
      apiFetch('/dashboard/ai-reports?limit=100', token),
    ]);
    if (sysRes.ok) {
      const s = await sysRes.json();
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
      setAiBriefingsOn(s.ai_status !== false);
      setMailboxCrawlOn(s.email_crawl_enabled !== false);
    }
    if (repRes.ok) {
      const body = (await repRes.json()) as { items?: AiReport[] };
      setReports(body.items ?? []);
    } else {
      setError('Could not load reports.');
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    if (authMe.role === 'EMPLOYEE') {
      router.replace('/dashboard');
      return;
    }
    setMe(authMe as Me);
    void loadData(token);
  }, [authLoading, authMe, token, router]);

  if (!me || authLoading) {
    return (
      <AppShell role="CEO" title="Reports" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Reports"
      subtitle={isHead ? 'Department briefings.' : 'Executive briefings.'}
      lastSyncLabel={lastSyncLabel}
      isActive={isActive}
      aiBriefingsEnabled={aiBriefingsOn}
      mailboxCrawlEnabled={mailboxCrawlOn}
      onRefresh={() => { if (token) void loadData(token); }}
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {!aiBriefingsOn ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          AI operations are off in Settings — new reports are not generated. Past reports below are unchanged.
        </p>
      ) : null}
      {reports.length === 0 ? (
        <section className="rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-slate-500">Reports appear on the hourly schedule.</p>
        </section>
      ) : (
        <div className="space-y-6">
          {reports.map((r, idx) => (
            <article
              key={`${r.created_at}-${idx}`}
              className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]"
            >
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
                <h3 className="text-base font-semibold text-slate-900">Briefing #{reports.length - idx}</h3>
                <time className="text-xs text-slate-500">
                  {new Date(r.generated_at || r.created_at).toLocaleString()}
                </time>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <SectionCard
                  title="Risks"
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  }
                >
                  <ul className="list-inside list-disc space-y-1">
                    {(r.key_issues ?? []).length ? (
                      (r.key_issues ?? []).map((line, i) => <li key={i}>{line}</li>)
                    ) : (
                      <li className="list-none text-slate-400">None flagged</li>
                    )}
                  </ul>
                </SectionCard>

                <SectionCard
                  title="People"
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  }
                >
                  <ul className="list-inside list-disc space-y-1">
                    {(r.employee_insights ?? []).length ? (
                      (r.employee_insights ?? []).map((line, i) => <li key={i}>{line}</li>)
                    ) : (
                      <li className="list-none text-slate-400">No notes</li>
                    )}
                  </ul>
                </SectionCard>

                <SectionCard
                  title="Patterns"
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                    </svg>
                  }
                >
                  <ul className="list-inside list-disc space-y-1">
                    {(r.patterns ?? []).length ? (
                      (r.patterns ?? []).map((line, i) => <li key={i}>{line}</li>)
                    ) : (
                      <li className="list-none text-slate-400">No patterns</li>
                    )}
                  </ul>
                </SectionCard>
              </div>

              <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                <div className="mb-1 flex items-center gap-2 text-indigo-900">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-semibold uppercase tracking-wide">Next step</span>
                </div>
                <p className="text-sm text-indigo-950">{r.recommendation || '—'}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
