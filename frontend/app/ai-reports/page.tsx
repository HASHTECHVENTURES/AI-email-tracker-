'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';

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
  id: string;
  created_at: string;
  generated_at: string;
  key_issues: string[];
  employee_insights: string[];
  patterns: string[];
  recommendation: string;
};

type SystemStatus = {
  last_sync_at: string | null;
  is_active: boolean;
  ai_status: boolean;
  email_crawl_enabled?: boolean;
  last_report_at?: string | null;
  seconds_until_next_report?: number | null;
};

function reportRowIdFromApi(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const o = item as Record<string, unknown>;
  const idVal = o.id;
  if (typeof idVal === 'string' && idVal.trim()) return idVal.trim();
  return '';
}

async function parseApiErrorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown; error?: string };
    if (typeof j.message === 'string') return j.message;
    if (typeof j.error === 'string') return j.error;
    if (j.message != null && typeof j.message === 'object') return JSON.stringify(j.message);
  } catch {
    /* non-JSON body */
  }
  return `Request failed (${res.status})`;
}

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
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [reports, setReports] = useState<AiReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [deletingReportId, setDeletingReportId] = useState<string | null>(null);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [lastReportLabel, setLastReportLabel] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [aiBriefingsOn, setAiBriefingsOn] = useState(true);
  const [mailboxCrawlOn, setMailboxCrawlOn] = useState(true);
  const [reportCountdownSec, setReportCountdownSec] = useState<number | null>(null);

  const loadData = useCallback(async (t: string) => {
    const [sysRes, repRes] = await Promise.all([
      apiFetch('/system/status', t),
      apiFetch('/dashboard/ai-reports?limit=100', t),
    ]);
    if (sysRes.ok) {
      const s = (await sysRes.json()) as SystemStatus;
      setLastSyncLabel(s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : null);
      setLastReportLabel(s.last_report_at ? new Date(s.last_report_at).toLocaleString() : null);
      setIsActive(Boolean(s.is_active));
      setAiBriefingsOn(s.ai_status !== false);
      setMailboxCrawlOn(s.email_crawl_enabled !== false);
      setReportCountdownSec(s.ai_status !== false ? (s.seconds_until_next_report ?? null) : null);
    }
    if (repRes.ok) {
      const body = (await repRes.json()) as { items?: unknown[] };
      const raw = body.items ?? [];
      setReports(
        raw.map((item) => {
          const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const nested =
            o.content && typeof o.content === 'object' ? (o.content as Record<string, unknown>) : null;
          const src = nested ?? o;
          const pickStrArr = (k: string): string[] => {
            const v = src[k];
            if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
            const v2 = o[k];
            return Array.isArray(v2) ? v2.filter((x): x is string => typeof x === 'string') : [];
          };
          const created =
            (typeof o.created_at === 'string' && o.created_at) ||
            (typeof src.created_at === 'string' && src.created_at) ||
            '';
          const generated =
            (typeof src.generated_at === 'string' && src.generated_at) ||
            (typeof o.generated_at === 'string' && o.generated_at) ||
            created;
          return {
            id: reportRowIdFromApi(item),
            created_at: created,
            generated_at: generated,
            key_issues: pickStrArr('key_issues'),
            employee_insights: pickStrArr('employee_insights'),
            patterns: pickStrArr('patterns'),
            recommendation:
              typeof src.recommendation === 'string'
                ? src.recommendation
                : typeof o.recommendation === 'string'
                  ? o.recommendation
                  : '',
          };
        }),
      );
      setError(null);
    } else {
      setError('Could not load reports.');
    }
  }, []);

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
    if (authMe.role !== 'CEO') {
      router.replace('/dashboard');
      return;
    }
    setMe(authMe as Me);
    void loadData(token);
  }, [authLoading, authMe?.id, authMe?.role, authMe?.company_name, token, router, loadData]);

  useEffect(() => {
    if (reportCountdownSec == null) return;
    const id = window.setInterval(() => {
      setReportCountdownSec((prev) => (prev != null && prev > 0 ? prev - 1 : prev));
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportCountdownSec != null]);

  const meId = me?.id;
  useEffect(() => {
    if (!token || !meId || reportCountdownSec !== 0) return;
    const id = window.setTimeout(() => void loadData(token), 2500);
    return () => clearTimeout(id);
  }, [reportCountdownSec, token, meId, loadData]);

  const reportCountdownLabel = useMemo(() => {
    if (reportCountdownSec == null) return null;
    const mins = Math.floor(reportCountdownSec / 60);
    const secs = reportCountdownSec % 60;
    return `in ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, [reportCountdownSec]);

  async function generateNow() {
    if (!token || !me) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await apiFetch('/dashboard/ai-report/generate', token);
      if (!res.ok) {
        setGenError(await parseApiErrorMessage(res));
        return;
      }
      await loadData(token);
    } finally {
      setGenerating(false);
    }
  }

  async function deleteReport(reportId: string) {
    if (!token || !me || !reportId) return;
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    setDeletingReportId(reportId);
    setGenError(null);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 25_000);

    try {
      const res = await apiFetch(`/dashboard/ai-reports/${encodeURIComponent(reportId)}`, token, {
        method: 'DELETE',
        signal: controller.signal,
      });
      if (!res.ok) {
        setGenError(await parseApiErrorMessage(res));
        return;
      }
      setReports((prev) => prev.filter((r) => r.id !== reportId));
      void loadData(token).catch(() => {});
    } catch (e) {
      const aborted =
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError');
      if (aborted) {
        setGenError('Delete timed out. Check your connection and try again.');
      } else {
        setGenError(e instanceof Error ? e.message : 'Delete failed.');
      }
    } finally {
      window.clearTimeout(timeoutId);
      setDeletingReportId(null);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell
        role={me?.role ?? shellRoleHint ?? 'EMPLOYEE'}
        title="Reports"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  const canGenerate = aiBriefingsOn && !generating;

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title="Reports"
      subtitle="Executive briefings — generated on the company schedule or on demand."
      lastSyncLabel={lastSyncLabel}
      nextIngestionCountdownLabel={null}
      nextReportCountdownLabel={aiBriefingsOn ? reportCountdownLabel : null}
      isActive={isActive}
      aiBriefingsEnabled={aiBriefingsOn}
      mailboxCrawlEnabled={mailboxCrawlOn}
      onRefresh={() => {
        if (token) void loadData(token);
      }}
      onSignOut={() => void ctxSignOut()}
    >
      <div className="flex flex-col gap-4">
        {lastReportLabel ? (
          <p className="text-xs text-slate-500">
            Last executive briefing run: <span className="font-medium text-slate-700">{lastReportLabel}</span>
          </p>
        ) : null}

        {aiBriefingsOn ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!canGenerate}
              onClick={() => void generateNow()}
              className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate executive briefing now'}
            </button>
          </div>
        ) : null}

        {genError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
            {genError}
          </p>
        ) : null}

        {!aiBriefingsOn ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            AI is off in company settings — new reports are not created. Older ones below are unchanged.
          </p>
        ) : null}

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {reports.length === 0 ? (
          <section className="rounded-xl border border-slate-200/80 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-medium text-slate-700">No reports in the archive yet</p>
            <p className="mt-2 text-sm text-slate-500">
              {aiBriefingsOn
                ? 'Reports appear after the hourly run or when you generate one.'
                : 'Saved briefings from when AI was on still load here. If nothing appears, try Refresh — or no reports were stored for this company yet. Turn AI on in Settings to create new ones.'}
            </p>
          </section>
        ) : (
          <div className="space-y-6">
            {reports.map((r, idx) => (
              <article
                key={r.id || `${r.created_at}-${idx}`}
                className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]"
              >
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-slate-900">Briefing #{reports.length - idx}</h3>
                    <time className="mt-0.5 block text-xs text-slate-500">
                      {new Date(r.generated_at || r.created_at).toLocaleString()}
                    </time>
                  </div>
                  <button
                    type="button"
                    disabled={!r.id || deletingReportId === r.id}
                    onClick={() => r.id && void deleteReport(r.id)}
                    className="shrink-0 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                    title={
                      r.id
                        ? 'Remove this report from the list'
                        : 'Report id missing — refresh after updating the API.'
                    }
                  >
                    {deletingReportId === r.id ? 'Deleting…' : 'Delete report'}
                  </button>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <SectionCard
                    title="Risks"
                    icon={
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
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
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                        />
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
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
                        />
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
      </div>
    </AppShell>
  );
}
