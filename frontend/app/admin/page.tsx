'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { useSupabaseRealtimeRefresh } from '@/lib/use-supabase-realtime-refresh';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PasswordInput } from '@/components/PasswordInput';

/* ───────── types ───────── */

type Stats = {
  companies_registered: number;
  total_users: number;
  total_employees: number;
  total_conversations: number;
  companies_with_ai_off: number;
  companies_with_email_crawl_off: number;
};

type PortalLoginRoles = {
  ceo: number;
  head: number;
  employee: number;
  platform_admin: number;
};

type CompanyRow = {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  user_count: number;
  employee_count: number;
  portal_login_roles?: PortalLoginRoles;
};

type DetailUser = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
  linked_employee_id: string | null;
};

type DetailEmployee = {
  id: string;
  name: string;
  email: string;
  mailbox_type: string | null;
  gmail_status: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  tracking_paused: boolean;
  tracking_start_at: string | null;
  last_synced_at: string | null;
  department_name: string | null;
  conversation_count: number;
  message_count: number;
};

type AiUsage = {
  ai_classified_messages: number;
  ai_enriched_conversations: number;
  ai_quota_fallback_messages: number;
  historical_search_runs: number;
  last_historical_search_at: string | null;
};

type CompanyDetail = {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  users: DetailUser[];
  employees: DetailEmployee[];
  ai_usage: AiUsage;
  totals: {
    users: number;
    employees: number;
    active_mailboxes: number;
    connected_mailboxes: number;
    conversations: number;
    messages: number;
    departments: number;
  };
};

type ActivityData = {
  timezone?: string;
  email_volume: {
    today: number;
    yesterday: number;
    this_week: number;
    this_month: number;
    total: number;
  };
  ai_usage: {
    classified_today: number;
    classified_yesterday: number;
    classified_week: number;
    classified_month: number;
    classified_total: number;
    skipped_today: number;
    skipped_yesterday: number;
    skipped_week: number;
    skipped_month: number;
    skipped_total: number;
  };
  daily_trend: Array<{
    date: string;
    ingested: number;
    classified: number;
    skipped: number;
  }>;
  employee_breakdown: Array<{
    employee_id: string;
    employee_name: string;
    employee_email: string;
    company_name: string;
    is_active: boolean;
    gmail_status: string | null;
    total_messages: number;
    messages_today: number;
    messages_yesterday: number;
    messages_week: number;
    messages_month: number;
    conversations: number;
    last_synced_at: string | null;
    latest_mail_sent_at?: string | null;
  }>;
};

const ACTIVITY_TZ = 'Asia/Kolkata';

function formatIstDate(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: ACTIVITY_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatIstDayKey(dateKey: string): string {
  try {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return dt.toLocaleDateString('en-IN', {
      timeZone: ACTIVITY_TZ,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateKey;
  }
}

type AdminView = 'dashboard' | 'companies' | 'add-company' | 'kill-switches' | 'activity';

/* ───────── small UI atoms ───────── */

function FlagSwitch({
  checked,
  busy,
  title,
  onToggle,
}: {
  checked: boolean;
  busy: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        if (busy) return;
        onToggle();
      }}
      className={`
        relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full p-1
        transition-colors duration-200 ease-out
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
        ${checked ? 'bg-brand-600 shadow-inner shadow-brand-900/10' : 'bg-slate-200'}
        ${busy ? 'pointer-events-none opacity-70' : 'hover:brightness-[1.02] active:brightness-[0.98]'}
      `}
    >
      <span
        aria-hidden
        className={`
          pointer-events-none absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/[0.06]
          transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]
          will-change-transform
          ${checked ? 'translate-x-5' : 'translate-x-0'}
        `}
      />
    </button>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${accent ?? 'text-slate-900'}`}>{value}</p>
    </div>
  );
}

function MiniStatCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-xl border border-slate-200/60 bg-white px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${accent ?? 'text-slate-900'}`}>{value}</p>
    </div>
  );
}

function gmailStatusBadge(s: string | null) {
  if (s === 'CONNECTED') return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">CONNECTED</span>;
  if (s === 'EXPIRED') return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">EXPIRED</span>;
  if (s === 'REVOKED') return <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800">REVOKED</span>;
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">NOT SET</span>;
}

function roleBadge(r: string) {
  const m: Record<string, string> = {
    CEO: 'bg-violet-100 text-violet-800',
    HEAD: 'bg-blue-100 text-blue-800',
    EMPLOYEE: 'bg-slate-100 text-slate-700',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${m[r] ?? 'bg-slate-100 text-slate-600'}`}>{r}</span>;
}

/** One-line breakdown of portal login rows (CEO / manager / employee accounts). */
function portalLoginRolesLine(r: PortalLoginRoles | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  if (r.ceo) parts.push(`${r.ceo} CEO`);
  if (r.head) parts.push(`${r.head} manager${r.head === 1 ? '' : 's'}`);
  if (r.employee) parts.push(`${r.employee} employee login${r.employee === 1 ? '' : 's'}`);
  if (r.platform_admin) parts.push(`${r.platform_admin} platform`);
  return parts.join(' · ');
}

/* ───────── view: Dashboard (clean KPIs only) ───────── */

function DashboardView({ stats, companies }: { stats: Stats | null; companies: CompanyRow[] }) {
  if (!stats) return null;

  const topCompanies = [...companies].sort((a, b) => b.employee_count - a.employee_count).slice(0, 5);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-4 text-lg font-bold text-slate-900">System overview</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Companies" value={stats.companies_registered} />
          <StatCard label="Portal users" value={stats.total_users} />
          <StatCard label="Tracked mailboxes" value={stats.total_employees} />
          <StatCard label="Conversations" value={stats.total_conversations} />
          <StatCard label="AI disabled" value={stats.companies_with_ai_off} accent={stats.companies_with_ai_off > 0 ? 'text-amber-600' : 'text-slate-900'} />
          <StatCard label="Crawl disabled" value={stats.companies_with_email_crawl_off} accent={stats.companies_with_email_crawl_off > 0 ? 'text-amber-600' : 'text-slate-900'} />
        </div>
      </section>

      {topCompanies.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-bold text-slate-900">Top companies by mailboxes</h2>
          <p className="mb-4 max-w-3xl text-xs leading-relaxed text-slate-500">
            Portal login totals count every sign-in stored for the tenant (CEO, managers, employee portals). That can be higher than what you see under Departments if old logins were not removed.
          </p>
          <div className="space-y-2">
            {topCompanies.map((c) => {
              const maxMb = topCompanies[0]?.employee_count || 1;
              const pct = Math.round((c.employee_count / maxMb) * 100);
              const roleLine = portalLoginRolesLine(c.portal_login_roles);
              return (
                <div key={c.id} className="rounded-xl border border-slate-200/60 bg-white px-4 py-3 shadow-card">
                  <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
                    <span className="font-medium text-slate-900">{c.name}</span>
                    <div className="text-right text-xs tabular-nums text-slate-500">
                      <div>
                        <span className="font-medium text-slate-700">{c.user_count}</span> portal login{c.user_count === 1 ? '' : 's'}
                      </div>
                      {roleLine ? <div className="mt-0.5 max-w-[280px] text-[11px] leading-snug text-slate-500">{roleLine}</div> : null}
                      <div className="mt-0.5">{c.employee_count} mailboxes</div>
                    </div>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-lg font-bold text-slate-900">Quick summary</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
            <p className="text-3xl font-bold text-brand-600">{stats.total_conversations}</p>
            <p className="mt-1 text-sm text-slate-500">total conversations tracked across all tenants</p>
          </div>
          <div className="rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
            <p className="text-3xl font-bold text-emerald-600">{stats.total_employees - (stats.companies_with_email_crawl_off)}</p>
            <p className="mt-1 text-sm text-slate-500">active mailboxes with email crawl enabled</p>
          </div>
          <div className="rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
            <p className="text-3xl font-bold text-violet-600">{stats.companies_registered - stats.companies_with_ai_off}</p>
            <p className="mt-1 text-sm text-slate-500">companies with AI enrichment active</p>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ───────── view: Company detail panel (expandable row) ───────── */

function CompanyDetailPanel({ detail, loading: detailLoading }: { detail: CompanyDetail | null; loading: boolean }) {
  if (detailLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-500">
        <svg className="h-4 w-4 animate-spin text-brand-500" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
        Loading company details...
      </div>
    );
  }
  if (!detail) return null;

  const t = detail.totals;
  const ai = detail.ai_usage;

  return (
    <div className="space-y-6 border-t border-slate-100 bg-slate-50/50 px-5 py-6 sm:px-8">
      {/* Company stats */}
      <div>
        <h4 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Company stats</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <MiniStatCard label="Users" value={t.users} />
          <MiniStatCard label="Mailboxes" value={t.employees} />
          <MiniStatCard label="Active" value={t.active_mailboxes} />
          <MiniStatCard label="Gmail linked" value={t.connected_mailboxes} />
          <MiniStatCard label="Conversations" value={t.conversations} />
          <MiniStatCard label="Messages" value={t.messages} />
          <MiniStatCard label="Departments" value={t.departments} />
        </div>
      </div>

      {/* Portal users */}
      <div>
        <h4 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Portal users ({detail.users.length})</h4>
        {detail.users.length === 0 ? (
          <p className="text-xs text-slate-400">No portal users.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200/50 bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {detail.users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2 font-medium text-slate-900">{u.full_name || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{u.email}</td>
                    <td className="px-3 py-2">{roleBadge(u.role)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">{new Date(u.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Tracked mailboxes */}
      <div>
        <h4 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Tracked mailboxes ({detail.employees.length})</h4>
        {detail.employees.length === 0 ? (
          <p className="text-xs text-slate-400">No mailboxes.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200/50 bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Gmail</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2">AI</th>
                  <th className="px-3 py-2">Dept</th>
                  <th className="px-3 py-2">Convos</th>
                  <th className="px-3 py-2">Msgs</th>
                  <th className="px-3 py-2">Last sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {detail.employees.map((emp) => (
                  <tr key={emp.id} className={`hover:bg-slate-50/60 ${!emp.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 font-medium text-slate-900">{emp.name}</td>
                    <td className="px-3 py-2 text-slate-600">{emp.email}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${emp.mailbox_type === 'SELF' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>
                        {emp.mailbox_type ?? 'TEAM'}
                      </span>
                    </td>
                    <td className="px-3 py-2">{gmailStatusBadge(emp.gmail_status)}</td>
                    <td className="px-3 py-2">{emp.is_active ? <span className="text-emerald-600">Yes</span> : <span className="text-red-500">No</span>}</td>
                    <td className="px-3 py-2">{emp.ai_enabled ? <span className="text-emerald-600">On</span> : <span className="text-slate-400">Off</span>}</td>
                    <td className="px-3 py-2 text-slate-500">{emp.department_name ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700">{emp.conversation_count}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700">{emp.message_count}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                      {emp.last_synced_at ? new Date(emp.last_synced_at).toLocaleString() : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI usage */}
      <div>
        <h4 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">AI usage</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <MiniStatCard label="AI classified emails" value={ai.ai_classified_messages} accent="text-blue-700" />
          <MiniStatCard label="AI enriched convos" value={ai.ai_enriched_conversations} accent="text-violet-700" />
          <MiniStatCard label="Quota fallback" value={ai.ai_quota_fallback_messages} accent={ai.ai_quota_fallback_messages > 0 ? 'text-amber-700' : 'text-slate-700'} />
          <MiniStatCard label="Historical searches" value={ai.historical_search_runs} accent="text-emerald-700" />
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200/60 bg-white px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Last historical search</p>
            <p className="mt-0.5 text-sm font-medium text-slate-700">
              {ai.last_historical_search_at ? new Date(ai.last_historical_search_at).toLocaleString() : 'Never'}
            </p>
          </div>
        </div>
        {ai.ai_quota_fallback_messages > 0 && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-800">
            {ai.ai_quota_fallback_messages} stored message(s) carry a quota-related relevance note (typically from an earlier ingest mode). New inbound mail is not ingested while Gemini API limits block classification, except safe direct human-mail fallback.
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────── view: Companies table ───────── */

function CompaniesView({
  companies,
  expandedCompanyId,
  companyDetails,
  detailLoading,
  onToggleDetail,
}: {
  companies: CompanyRow[];
  expandedCompanyId: string | null;
  companyDetails: Record<string, CompanyDetail>;
  detailLoading: string | null;
  onToggleDetail: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Companies</h2>
        <p className="mt-1 text-sm text-slate-500">Click any company to view full details — portal logins, mailboxes, conversations, and AI usage.</p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="w-8 px-4 py-3" />
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">
                Portal logins
                <span className="mt-0.5 block text-[10px] font-normal normal-case tracking-normal text-slate-400">by role</span>
              </th>
              <th className="px-4 py-3">Mailboxes</th>
              <th className="px-4 py-3">AI</th>
              <th className="px-4 py-3">Crawl</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {companies.map((c) => {
              const isExpanded = expandedCompanyId === c.id;
              const roleLine = portalLoginRolesLine(c.portal_login_roles);
              return (
                <Fragment key={c.id}>
                  <tr
                    className={`cursor-pointer transition-colors ${isExpanded ? 'bg-brand-50/40' : 'hover:bg-slate-50/50'}`}
                    onClick={() => onToggleDetail(c.id)}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      <svg className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                      </svg>
                    </td>
                    <td className="px-4 py-3 font-semibold text-brand-700">{c.name}</td>
                    <td className="px-4 py-3 text-slate-600">
                      <div className="tabular-nums font-medium">{c.user_count}</div>
                      {roleLine ? (
                        <div className="mt-0.5 max-w-[240px] text-[11px] leading-snug text-slate-500">{roleLine}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">{c.employee_count}</td>
                    <td className="px-4 py-3">
                      {c.admin_ai_enabled
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">On</span>
                        : <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Off</span>}
                    </td>
                    <td className="px-4 py-3">
                      {c.admin_email_crawl_enabled
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">On</span>
                        : <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Off</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <CompanyDetailPanel detail={companyDetails[c.id] ?? null} loading={detailLoading === c.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {companies.length === 0 && (
          <p className="p-8 text-center text-sm text-slate-500">No companies yet.</p>
        )}
      </div>
    </div>
  );
}

/* ───────── view: Add company form ───────── */

function AddCompanyView({
  token,
  onCreated,
}: {
  token: string | null;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !name.trim()) return;
    setCreating(true);
    setError(null);
    setSuccess(false);
    try {
      const body: Record<string, string> = { name: name.trim() };
      if (email.trim() && password) {
        body.ceo_email = email.trim();
        body.ceo_password = password;
      }
      const res = await apiFetch('/platform-admin/companies', token, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not create company');
        return;
      }
      setName('');
      setEmail('');
      setPassword('');
      setSuccess(true);
      await onCreated();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Add company</h2>
        <p className="mt-1 text-sm text-slate-500">Create a new organization. Optionally provision a CEO login at the same time.</p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          Company created successfully.
        </div>
      )}

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-2xl border border-slate-200/60 bg-white p-6 shadow-card">
        <label className="block text-sm font-medium text-slate-700">
          Company name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            placeholder="Acme Corp"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            CEO email <span className="text-slate-400">(optional)</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm"
              placeholder="ceo@acme.com"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            CEO password <span className="text-slate-400">(optional)</span>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm"
              autoComplete="new-password"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={creating}
          className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-50"
        >
          {creating ? 'Creating...' : 'Create company'}
        </button>
      </form>
    </div>
  );
}

/* ───────── view: Kill switches ───────── */

function KillSwitchesView({
  companies,
  pendingFlagPatch,
  deletingId,
  onPatchFlags,
  onRemoveCompany,
}: {
  companies: CompanyRow[];
  pendingFlagPatch: { id: string; field: 'ai' | 'email' } | null;
  deletingId: string | null;
  onPatchFlags: (id: string, patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean }) => void;
  onRemoveCompany: (id: string, name: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Kill switches</h2>
        <p className="mt-1 text-sm text-slate-500">
          Toggle AI enrichment and email ingestion per company. These are platform-level overrides.
        </p>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">How kill switches work</p>
        <p className="mt-1 text-amber-800/90">
          Disabling <strong>AI</strong> stops inbox classification and conversation enrichment for that tenant.
          Disabling <strong>Email crawl</strong> stops Gmail sync for all mailboxes in that company.
          Company-level CEO Settings still apply on top of these platform overrides.
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">
                Portal logins
                <span className="mt-0.5 block text-[10px] font-normal normal-case tracking-normal text-slate-400">by role</span>
              </th>
              <th className="px-4 py-3">Mailboxes</th>
              <th className="px-4 py-3">AI allowed</th>
              <th className="px-4 py-3">Email ingest</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {companies.map((c) => {
              const roleLine = portalLoginRolesLine(c.portal_login_roles);
              return (
              <tr key={c.id} className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                <td className="px-4 py-3 text-slate-600">
                  <div className="tabular-nums font-medium">{c.user_count}</div>
                  {roleLine ? (
                    <div className="mt-0.5 max-w-[220px] text-[11px] leading-snug text-slate-500">{roleLine}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{c.employee_count}</td>
                <td className="px-4 py-3">
                  <FlagSwitch
                    checked={c.admin_ai_enabled}
                    busy={pendingFlagPatch?.id === c.id && pendingFlagPatch.field === 'ai'}
                    title="AI enrichment"
                    onToggle={() => onPatchFlags(c.id, { admin_ai_enabled: !c.admin_ai_enabled })}
                  />
                </td>
                <td className="px-4 py-3">
                  <FlagSwitch
                    checked={c.admin_email_crawl_enabled}
                    busy={pendingFlagPatch?.id === c.id && pendingFlagPatch.field === 'email'}
                    title="Gmail ingestion"
                    onToggle={() => onPatchFlags(c.id, { admin_email_crawl_enabled: !c.admin_email_crawl_enabled })}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onRemoveCompany(c.id, c.name)}
                    disabled={deletingId === c.id}
                    className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {deletingId === c.id ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {companies.length === 0 && (
          <p className="p-8 text-center text-sm text-slate-500">No companies yet.</p>
        )}
      </div>
    </div>
  );
}

/* ───────── view: Activity & Usage ───────── */

type TimePeriod = 'today' | 'yesterday' | 'week' | 'month' | 'total';

function periodLabel(p: TimePeriod): string {
  if (p === 'today') return 'Today (IST)';
  if (p === 'yesterday') return 'Yesterday (IST)';
  if (p === 'week') return 'Last 7 days (IST)';
  if (p === 'month') return 'This month (IST)';
  return 'All time';
}

function getVolume(v: ActivityData['email_volume'], p: TimePeriod): number {
  if (p === 'today') return v.today;
  if (p === 'yesterday') return v.yesterday ?? 0;
  if (p === 'week') return v.this_week;
  if (p === 'month') return v.this_month;
  return v.total;
}

function getAi(a: ActivityData['ai_usage'], field: 'classified' | 'skipped', p: TimePeriod): number {
  const suffix =
    p === 'today' ? 'today' : p === 'yesterday' ? 'yesterday' : p === 'week' ? 'week' : p === 'month' ? 'month' : 'total';
  const key = `${field}_${suffix}` as keyof ActivityData['ai_usage'];
  return (a[key] as number) ?? 0;
}

function getEmpMessages(e: ActivityData['employee_breakdown'][number], p: TimePeriod): number {
  if (p === 'today') return e.messages_today;
  if (p === 'yesterday') return e.messages_yesterday ?? 0;
  if (p === 'week') return e.messages_week;
  if (p === 'month') return e.messages_month;
  return e.total_messages;
}

function ActivityView({ data, loading: actLoading }: { data: ActivityData | null; loading: boolean }) {
  const [period, setPeriod] = useState<TimePeriod>('today');
  const [sortBy, setSortBy] = useState<'messages' | 'conversations'>('messages');
  const [searchTerm, setSearchTerm] = useState('');

  if (actLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <svg className="h-4 w-4 animate-spin text-brand-500" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
        Loading activity data...
      </div>
    );
  }
  if (!data) return null;

  const employees = [...data.employee_breakdown]
    .filter((e) => {
      if (!searchTerm.trim()) return true;
      const q = searchTerm.toLowerCase();
      return e.employee_name.toLowerCase().includes(q) || e.employee_email.toLowerCase().includes(q) || e.company_name.toLowerCase().includes(q);
    })
    .sort((a, b) =>
      sortBy === 'messages'
        ? getEmpMessages(b, period) - getEmpMessages(a, period)
        : b.conversations - a.conversations,
    );

  const periods: TimePeriod[] = ['today', 'yesterday', 'week', 'month', 'total'];
  const trend = data.daily_trend ?? [];
  const maxTrendIngested = trend.length > 0 ? Math.max(...trend.map((d) => d.ingested), 1) : 1;

  return (
    <div className="space-y-8">
      <p className="text-xs text-slate-500">
        All day boundaries use <strong className="font-medium text-slate-700">{data.timezone ?? ACTIVITY_TZ}</strong> (India time).
        Counts are based on each mail's actual sent date (not sync time). &quot;Yesterday&quot; is the previous IST calendar day — e.g. 1 Jun when today is 2 Jun.
      </p>

      {/* Period toggle */}
      <div className="flex flex-wrap items-center gap-2">
        {periods.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              period === p
                ? 'bg-brand-600 text-white shadow-sm'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            {periodLabel(p)}
          </button>
        ))}
      </div>

      {/* Daily trend (last 14 IST days) */}
      {trend.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-bold text-slate-900">Daily trend (last 14 days, IST)</h2>
          <p className="mb-4 text-xs text-slate-500">One row per calendar day in India time — includes yesterday and today.</p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3">Date (IST)</th>
                  <th className="px-4 py-3 text-right">Ingested</th>
                  <th className="px-4 py-3 text-right">AI classified</th>
                  <th className="px-4 py-3 text-right">AI skipped</th>
                  <th className="px-4 py-3 w-32" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {[...trend].reverse().map((row) => (
                  <tr key={row.date} className="hover:bg-slate-50/50">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{formatIstDayKey(row.date)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{row.ingested}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-violet-700">{row.classified}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{row.skipped}</td>
                    <td className="px-4 py-2.5">
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${Math.round((row.ingested / maxTrendIngested) * 100)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Email volume + AI usage cards */}
      <section>
        <h2 className="mb-4 text-lg font-bold text-slate-900">Email volume — {periodLabel(period).toLowerCase()}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Emails ingested" value={getVolume(data.email_volume, period)} accent="text-brand-600" />
          <StatCard label="AI classified" value={getAi(data.ai_usage, 'classified', period)} accent="text-violet-600" />
          <StatCard label="AI skipped" value={getAi(data.ai_usage, 'skipped', period)} accent="text-amber-600" />
          <StatCard
            label="Pass rate"
            value={
              getVolume(data.email_volume, period) + getAi(data.ai_usage, 'skipped', period) > 0
                ? `${Math.round((getVolume(data.email_volume, period) / (getVolume(data.email_volume, period) + getAi(data.ai_usage, 'skipped', period))) * 100)}%`
                : '—'
            }
            accent="text-emerald-600"
          />
        </div>
      </section>

      {/* All-time totals row */}
      {period !== 'total' && (
        <section>
          <h2 className="mb-4 text-lg font-bold text-slate-900">All-time totals</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MiniStatCard label="Total emails" value={data.email_volume.total.toLocaleString()} />
            <MiniStatCard label="Total AI classified" value={data.ai_usage.classified_total.toLocaleString()} />
            <MiniStatCard label="Total AI skipped" value={data.ai_usage.skipped_total.toLocaleString()} />
            <MiniStatCard label="Employees tracked" value={data.employee_breakdown.length} />
          </div>
        </section>
      )}

      {/* Per-employee table */}
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">Per-employee breakdown</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search name, email, company..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'messages' | 'conversations')}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 shadow-sm"
            >
              <option value="messages">Sort by emails</option>
              <option value="conversations">Sort by conversations</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Gmail</th>
                <th className="px-4 py-3 text-right">Emails ({periodLabel(period).toLowerCase()})</th>
                <th className="px-4 py-3 text-right">Total emails</th>
                <th className="px-4 py-3 text-right">Conversations</th>
                <th className="px-4 py-3">Latest mail (actual)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {employees.map((e) => {
                const msgCount = getEmpMessages(e, period);
                const maxMsg = employees.length > 0 ? Math.max(...employees.map((x) => getEmpMessages(x, period)), 1) : 1;
                return (
                  <tr key={e.employee_id} className={`hover:bg-slate-50/50 ${!e.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{e.employee_name}</div>
                      <div className="text-xs text-slate-500">{e.employee_email}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{e.company_name}</td>
                    <td className="px-4 py-3">{gmailStatusBadge(e.gmail_status)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-brand-500 transition-all"
                            style={{ width: `${Math.round((msgCount / maxMsg) * 100)}%` }}
                          />
                        </div>
                        <span className="min-w-[2.5rem] tabular-nums font-medium text-slate-900">{msgCount}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{e.total_messages.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{e.conversations}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                      {formatIstDate(e.latest_mail_sent_at ?? null)}
                    </td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">No employees match your search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ───────── main page ───────── */

function hashToView(hash: string): AdminView {
  if (hash === '#companies') return 'companies';
  if (hash === '#add-company') return 'add-company';
  if (hash === '#kill-switches') return 'kill-switches';
  if (hash === '#activity') return 'activity';
  return 'dashboard';
}

const VIEW_TITLES: Record<AdminView, { title: string; subtitle: string }> = {
  dashboard: { title: 'Platform admin', subtitle: 'System-wide KPIs and company overview.' },
  companies: { title: 'Companies', subtitle: 'All registered companies with detailed breakdowns.' },
  'add-company': { title: 'Add company', subtitle: 'Register a new organization in the system.' },
  'kill-switches': { title: 'Kill switches', subtitle: 'Per-tenant AI and email ingestion overrides.' },
  activity: { title: 'Activity & Usage', subtitle: 'Real-time email volume, AI consumption, and per-employee breakdowns.' },
};

export default function PlatformAdminPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCompanyId, setExpandedCompanyId] = useState<string | null>(null);
  const [companyDetails, setCompanyDetails] = useState<Record<string, CompanyDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingFlagPatch, setPendingFlagPatch] = useState<{ id: string; field: 'ai' | 'email' } | null>(null);
  const savingFlagKeysRef = useRef<Set<string>>(new Set());
  const [activityData, setActivityData] = useState<ActivityData | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const [activeView, setActiveView] = useState<AdminView>('dashboard');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setActiveView(hashToView(window.location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const loadActivity = useCallback(async () => {
    if (!token) return;
    setActivityLoading(true);
    try {
      const res = await apiFetch('/platform-admin/activity', token);
      if (res.ok) setActivityData((await res.json()) as ActivityData);
    } finally {
      setActivityLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (activeView === 'activity' && token && allowed) {
      void loadActivity();
    }
  }, [activeView, token, allowed, loadActivity]);

  const load = useCallback(async () => {
    if (!token) return;
    const meRes = await apiFetch('/platform-admin/me', token);
    if (!meRes.ok) {
      setAllowed(false);
      setLoading(false);
      return;
    }
    const meBody = (await meRes.json()) as { allowed?: boolean };
    if (!meBody.allowed) {
      setAllowed(false);
      setLoading(false);
      return;
    }
    setAllowed(true);
    const [sRes, cRes] = await Promise.all([
      apiFetch('/platform-admin/stats', token),
      apiFetch('/platform-admin/companies', token),
    ]);
    if (sRes.ok) setStats((await sRes.json()) as Stats);
    if (cRes.ok) {
      setCompanies(((await cRes.json()) as CompanyRow[]) ?? []);
      setError(null);
    } else {
      setError(await readApiErrorMessage(cRes, 'Could not load companies. Try again.'));
    }
    setLoading(false);
  }, [token]);

  useRefetchOnFocus(() => void load(), Boolean(token && !authLoading && allowed === true));

  useSupabaseRealtimeRefresh({
    enabled: Boolean(token && !authLoading && allowed === true),
    channelSuffix: 'platform-admin-companies',
    tables: [{ table: 'companies' }],
    onSignal: () => void load(),
    debounceMs: 450,
  });

  const toggleCompanyDetail = useCallback(async (companyId: string) => {
    if (expandedCompanyId === companyId) {
      setExpandedCompanyId(null);
      return;
    }
    setExpandedCompanyId(companyId);
    if (companyDetails[companyId]) return;
    if (!token) return;
    setDetailLoading(companyId);
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(companyId)}/detail`, token);
      if (res.ok) {
        const data = (await res.json()) as CompanyDetail;
        setCompanyDetails((prev) => ({ ...prev, [companyId]: data }));
      }
    } finally {
      setDetailLoading(null);
    }
  }, [token, expandedCompanyId, companyDetails]);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      router.replace('/admin/login?next=/admin');
      return;
    }
    setLoading(true);
    void load();
  }, [authLoading, token, router, load]);

  async function patchFlags(
    id: string,
    patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean },
  ) {
    if (!token) return;
    const field: 'ai' | 'email' = patch.admin_ai_enabled !== undefined ? 'ai' : 'email';
    const lockKey = `${id}:${field}`;
    if (savingFlagKeysRef.current.has(lockKey)) return;
    savingFlagKeysRef.current.add(lockKey);

    const snapshot = companies;
    setPendingFlagPatch({ id, field });
    setError(null);
    setCompanies((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(id)}/flags`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setCompanies(snapshot);
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Update failed');
        return;
      }
      const sRes = await apiFetch('/platform-admin/stats', token);
      if (sRes.ok) setStats((await sRes.json()) as Stats);
    } finally {
      savingFlagKeysRef.current.delete(lockKey);
      setPendingFlagPatch(null);
    }
  }

  async function removeCompany(id: string, name: string) {
    if (!token) return;
    if (!window.confirm(`Delete company "${name}" and all related data? This cannot be undone.`)) return;
    setDeletingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Delete failed');
        return;
      }
      setCompanies((rows) => rows.filter((c) => c.id !== id));
      setCompanyDetails((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setExpandedCompanyId((cur) => (cur === id ? null : cur));
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  const viewMeta = VIEW_TITLES[activeView];

  if (authLoading || loading) {
    return (
      <AppShell role="PLATFORM_ADMIN" title="Platform admin" subtitle="" onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (allowed === false) {
    return (
      <AppShell
        role="PLATFORM_ADMIN"
        companyName={me?.company_name ?? null}
        userDisplayName={me?.full_name?.trim() || me?.email}
        title="Access denied"
        subtitle="You do not have platform administrator access."
        onSignOut={() => void signOut()}
      >
        <p className="text-sm text-slate-600">
          Ask your operator to add your email to{' '}
          <code className="rounded bg-slate-100 px-1">PLATFORM_ADMIN_EMAILS</code> on the API server.
        </p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
          Back to dashboard
        </Link>
      </AppShell>
    );
  }

  return (
    <AppShell
      role="PLATFORM_ADMIN"
      companyName={me?.company_name ?? null}
      userDisplayName={me?.full_name?.trim() || me?.email}
      title={viewMeta.title}
      subtitle={viewMeta.subtitle}
      onSignOut={() => void signOut()}
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {activeView === 'dashboard' && <DashboardView stats={stats} companies={companies} />}

      {activeView === 'companies' && (
        <CompaniesView
          companies={companies}
          expandedCompanyId={expandedCompanyId}
          companyDetails={companyDetails}
          detailLoading={detailLoading}
          onToggleDetail={(id) => void toggleCompanyDetail(id)}
        />
      )}

      {activeView === 'add-company' && (
        <AddCompanyView token={token} onCreated={load} />
      )}

      {activeView === 'kill-switches' && (
        <KillSwitchesView
          companies={companies}
          pendingFlagPatch={pendingFlagPatch}
          deletingId={deletingId}
          onPatchFlags={(id, patch) => void patchFlags(id, patch)}
          onRemoveCompany={(id, name) => void removeCompany(id, name)}
        />
      )}

      {activeView === 'activity' && (
        <ActivityView data={activityData} loading={activityLoading} />
      )}
    </AppShell>
  );
}
