'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PageHeader, StatCard } from '@/components/admin/ui';
import { formatBytes, formatInr } from '@/lib/admin/format';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';
import type { BillingOverview } from '@/lib/admin/types';

function formatDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export default function AdminBillingPage() {
  return (
    <Suspense
      fallback={
        <AdminShell title="Billing" userDisplayName={undefined} onSignOut={() => undefined}>
          <PortalPageLoader variant="embedded" />
        </AdminShell>
      }
    >
      <AdminBillingPageContent />
    </Suspense>
  );
}

function AdminBillingPageContent() {
  const searchParams = useSearchParams();
  const { allowed, loading, me, signOut, token } = usePlatformAdmin('/billing');
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState('');

  const loadBilling = useCallback(
    async (month?: string) => {
      if (!token || !allowed) return;
      setLoadErr(null);
      const query = month ? `?month=${encodeURIComponent(month)}` : '';
      const res = await apiFetch(`/platform-admin/billing${query}`, token);
      if (!res.ok) {
        setLoadErr(
          res.status === 404
            ? 'Billing API is not on the live backend yet. Redeploy the Railway API from latest main, then refresh.'
            : 'Could not load billing data.',
        );
        return;
      }
      const data = (await res.json()) as BillingOverview;
      setBilling(data);
      setSelectedMonth(data.period.month);
    },
    [token, allowed],
  );

  useEffect(() => {
    const month = searchParams.get('month') ?? undefined;
    void loadBilling(month);
  }, [loadBilling, searchParams]);

  const monthOptions = useMemo(() => {
    const fromApi = billing?.monthly_summaries ?? [];
    const months = new Map(fromApi.map((m) => [m.month, m]));
    if (billing?.period.month && !months.has(billing.period.month)) {
      months.set(billing.period.month, {
        month: billing.period.month,
        label: billing.period.label,
        api_calls: billing.platform_totals.api_calls,
        api_cost_inr: billing.platform_totals.api_cost_inr,
        is_current_month: billing.period.is_current_month,
      });
    }
    return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
  }, [billing]);

  const activeDays = useMemo(
    () => (billing?.daily_totals ?? []).filter((d) => d.api_calls > 0),
    [billing],
  );

  if (loading) {
    return (
      <AdminShell title="Billing" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) return null;

  return (
    <AdminShell title="Billing & usage" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="Per-company costs"
        description="Each month is billed separately. Pick a calendar month to see day-wise API totals — nothing carries over month to month."
      />
      {loadErr ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadErr}</div> : null}

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-600">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Billing month (IST)</span>
          <select
            className="min-w-[200px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value);
              void loadBilling(e.target.value);
            }}
          >
            {monthOptions.map((m) => (
              <option key={m.month} value={m.month}>
                {m.label}
                {m.is_current_month ? ' (current)' : ''} — {formatInr(m.api_cost_inr)} API
              </option>
            ))}
          </select>
        </label>
      </div>

      {billing?.metering ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">{billing.period.label} only — not cumulative</p>
          <p className="mt-1">{billing.metering.disclaimer}</p>
          <p className="mt-2 text-xs text-amber-900">
            Measured: {billing.metering.live_api_calls.toLocaleString()} calls ({formatInr(billing.platform_totals.live_api_cost_inr)})
            {billing.metering.estimated_backfill_calls > 0
              ? ` · Historical est.: ${billing.metering.estimated_backfill_calls.toLocaleString()} calls (${formatInr(billing.platform_totals.estimated_api_cost_inr)})`
              : ''}
          </p>
          <p className="mt-1 text-xs text-amber-900">{billing.metering.storage_note}</p>
        </div>
      ) : null}

      {!billing ? (
        <PortalPageLoader variant="embedded" />
      ) : (
        <div className="space-y-8">
          <section>
            <p className="mb-3 text-xs text-slate-500">
              {billing.period.label} ({billing.period.timezone})
              {billing.period.is_current_month ? ' · month to date' : ' · full calendar month'}
              {' · '}Rates: input ${billing.rates.gemini_input_usd_per_1m}/1M, output ${billing.rates.gemini_output_usd_per_1m}/1M
              {' · '}FX {billing.currency.usd_to_inr} INR/USD
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="API (measured)" value={formatInr(billing.platform_totals.live_api_cost_inr)} sub={`${billing.platform_totals.live_api_calls.toLocaleString()} calls`} />
              <StatCard label="API (historical est.)" value={formatInr(billing.platform_totals.estimated_api_cost_inr)} sub={`${billing.platform_totals.estimated_api_calls.toLocaleString()} calls`} />
              <StatCard
                label="Month total"
                value={formatInr(billing.platform_totals.total_cost_inr)}
                accent="text-brand-600"
                sub={
                  billing.period.is_current_month
                    ? `incl. storage ${formatInr(billing.platform_totals.storage_cost_inr)}`
                    : 'API only (past month)'
                }
              />
              <StatCard label="Tokens" value={billing.platform_totals.total_tokens.toLocaleString()} sub={`${billing.platform_totals.api_calls.toLocaleString()} calls`} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Day-wise API total ({billing.period.label})</h2>
            <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Date (IST)</th>
                    <th className="px-4 py-3 text-right">Calls</th>
                    <th className="px-4 py-3 text-right">Tokens</th>
                    <th className="px-4 py-3 text-right">Measured</th>
                    <th className="px-4 py-3 text-right">Historical est.</th>
                    <th className="px-4 py-3 text-right">Day total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {activeDays.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                        No API usage recorded in this month.
                      </td>
                    </tr>
                  ) : (
                    activeDays.map((row) => (
                      <tr key={row.day} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-medium text-slate-900">{formatDayLabel(row.day)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{row.api_calls.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{row.total_tokens.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatInr(row.live_api_cost_inr)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{formatInr(row.estimated_api_cost_inr)}</td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold text-brand-700">{formatInr(row.api_cost_inr)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {activeDays.length > 0 ? (
                  <tfoot className="border-t border-slate-100 bg-slate-50/50 text-sm font-semibold">
                    <tr>
                      <td className="px-4 py-3">Month total</td>
                      <td className="px-4 py-3 text-right tabular-nums">{billing.platform_totals.api_calls.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{billing.platform_totals.total_tokens.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInr(billing.platform_totals.live_api_cost_inr)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInr(billing.platform_totals.estimated_api_cost_inr)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-brand-700">{formatInr(billing.platform_totals.api_cost_inr)}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </section>

          {billing.monthly_summaries.length > 1 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Other months (API only)</h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {billing.monthly_summaries
                  .filter((m) => m.month !== billing.period.month)
                  .map((m) => (
                    <button
                      key={m.month}
                      type="button"
                      onClick={() => {
                        setSelectedMonth(m.month);
                        void loadBilling(m.month);
                      }}
                      className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-brand-200 hover:bg-brand-50/40"
                    >
                      <p className="font-medium text-slate-900">{m.label}</p>
                      <p className="mt-1 text-sm text-slate-600">{formatInr(m.api_cost_inr)} · {m.api_calls.toLocaleString()} calls</p>
                    </button>
                  ))}
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">By company ({billing.period.label})</h2>
            <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3 text-right">API calls</th>
                    <th className="px-4 py-3 text-right">Tokens</th>
                    <th className="px-4 py-3 text-right">Measured</th>
                    <th className="px-4 py-3 text-right">Historical est.</th>
                    <th className="px-4 py-3 text-right">Storage</th>
                    <th className="px-4 py-3 text-right">Month total</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {billing.companies.map((row) => (
                    <tr key={row.company_id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3 font-medium text-slate-900">{row.company_name}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.api_calls.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{row.total_tokens.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInr(row.live_api_cost_inr)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{formatInr(row.estimated_api_cost_inr)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {row.storage_cost_inr > 0 ? formatInr(row.storage_cost_inr) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-brand-700">{formatInr(row.total_cost_inr)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/companies/${row.company_id}?month=${billing.period.month}`} className="text-brand-600 hover:underline">
                          Details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </AdminShell>
  );
}
