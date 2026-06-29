'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PageHeader, StatCard } from '@/components/admin/ui';
import { formatBytes, formatInr } from '@/lib/admin/format';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';
import type { BillingOverview } from '@/lib/admin/types';

export default function AdminBillingPage() {
  const { allowed, loading, me, signOut, token } = usePlatformAdmin('/billing');
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !allowed) return;
    void apiFetch('/platform-admin/billing', token).then(async (res) => {
      if (!res.ok) {
        setLoadErr(
          res.status === 404
            ? 'Billing API is not on the live backend yet. Redeploy the Railway API from latest main (commit with /platform-admin/billing), then refresh.'
            : 'Could not load billing data.',
        );
        return;
      }
      setBilling((await res.json()) as BillingOverview);
    });
  }, [token, allowed]);

  if (loading) {
    return (
      <AdminShell title="Billing" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) return null;

  const periodLabel = billing
    ? `${new Date(billing.period.from).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })} – today`
    : '';

  return (
    <AdminShell title="Billing & usage" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="Per-company costs"
        description="Estimated Gemini API + stored email data for the current billing period. Use these figures to invoice each tenant."
      />
      {loadErr ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadErr}</div> : null}

      {billing?.metering ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">Cost estimate (not a Google invoice)</p>
          <p className="mt-1">{billing.metering.disclaimer}</p>
          <p className="mt-2 text-xs text-amber-900">
            Measured calls: {billing.metering.live_api_calls.toLocaleString()} ({formatInr(billing.platform_totals.live_api_cost_inr)})
            {billing.metering.estimated_backfill_calls > 0
              ? ` · Historical estimates: ${billing.metering.estimated_backfill_calls.toLocaleString()} (${formatInr(billing.platform_totals.estimated_api_cost_inr)})`
              : ''}
            {billing.metering.metered_since
              ? ` · Live metering since ${new Date(billing.metering.metered_since).toLocaleDateString('en-IN')}`
              : ''}
          </p>
          <p className="mt-1 text-xs text-amber-900">{billing.metering.calibration_note}</p>
          <p className="mt-1 text-xs text-amber-900">{billing.metering.storage_note}</p>
        </div>
      ) : null}

      {!billing ? (
        <PortalPageLoader variant="embedded" />
      ) : (
        <div className="space-y-8">
          <section>
            <p className="mb-3 text-xs text-slate-500">
              Period: {periodLabel} · Rates: input ${billing.rates.gemini_input_usd_per_1m}/1M tokens, output $
              {billing.rates.gemini_output_usd_per_1m}/1M · Storage ${billing.rates.storage_usd_per_gb_month}/GB/mo · FX{' '}
              {billing.currency.usd_to_inr} INR/USD
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="API (measured)" value={formatInr(billing.platform_totals.live_api_cost_inr)} sub={`${billing.platform_totals.live_api_calls.toLocaleString()} calls`} />
              <StatCard label="API (historical est.)" value={formatInr(billing.platform_totals.estimated_api_cost_inr)} sub={`${billing.platform_totals.estimated_api_calls.toLocaleString()} calls`} />
              <StatCard label="Total billable" value={formatInr(billing.platform_totals.total_cost_inr)} accent="text-brand-600" sub={`incl. storage ${formatInr(billing.platform_totals.storage_cost_inr)}`} />
              <StatCard label="Tokens" value={billing.platform_totals.total_tokens.toLocaleString()} sub={`${billing.platform_totals.api_calls.toLocaleString()} API calls`} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">By company</h2>
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
                    <th className="px-4 py-3 text-right">Storage (INR)</th>
                    <th className="px-4 py-3 text-right">Total (INR)</th>
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
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{formatBytes(row.storage_bytes)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInr(row.storage_cost_inr)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-brand-700">{formatInr(row.total_cost_inr)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/companies/${row.company_id}`} className="text-brand-600 hover:underline">
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
