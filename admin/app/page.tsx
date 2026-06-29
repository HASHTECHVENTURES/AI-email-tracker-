'use client';

import Link from 'next/link';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { StatCard } from '@/components/admin/ui';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { formatInr } from '@/lib/admin/format';
import { apiFetch } from '@/lib/api';
import { useEffect, useState } from 'react';
import type { BillingOverview } from '@/lib/admin/types';

export default function AdminDashboardPage() {
  const { allowed, loading, stats, companies, me, signOut, token } = usePlatformAdmin('/');
  const [billing, setBilling] = useState<BillingOverview | null>(null);

  useEffect(() => {
    if (!token || !allowed) return;
    void apiFetch('/platform-admin/billing', token).then(async (res) => {
      if (res.ok) setBilling((await res.json()) as BillingOverview);
    });
  }, [token, allowed]);

  if (loading) {
    return (
      <AdminShell title="Overview" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) {
    return (
      <AdminShell title="Access denied" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <p className="text-sm text-slate-600">Your account is not in PLATFORM_ADMIN_EMAILS.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell title="Overview" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Platform</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Companies" value={stats?.companies_registered ?? 0} />
            <StatCard label="Portal users" value={stats?.total_users ?? 0} />
            <StatCard label="Mailboxes" value={stats?.total_employees ?? 0} />
            <StatCard label="Conversations" value={stats?.total_conversations ?? 0} />
            <StatCard label="AI off" value={stats?.companies_with_ai_off ?? 0} accent="text-amber-600" />
            <StatCard label="Crawl off" value={stats?.companies_with_email_crawl_off ?? 0} accent="text-amber-600" />
          </div>
        </section>

        {billing ? (
          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">This month (est.)</h2>
              <Link href="/billing" className="text-sm font-medium text-brand-600 hover:underline">
                Full billing →
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="API cost" value={formatInr(billing.platform_totals.api_cost_inr)} sub={`${billing.platform_totals.api_calls} calls`} />
              <StatCard label="Storage cost" value={formatInr(billing.platform_totals.storage_cost_inr)} accent="text-violet-600" />
              <StatCard label="Total billable" value={formatInr(billing.platform_totals.total_cost_inr)} accent="text-brand-600" />
              <StatCard label="Tokens used" value={billing.platform_totals.total_tokens.toLocaleString()} />
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Companies</h2>
            <Link href="/companies" className="text-sm font-medium text-brand-600 hover:underline">
              View all →
            </Link>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Mailboxes</th>
                  <th className="px-4 py-3">AI</th>
                  <th className="px-4 py-3">Crawl</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {companies.slice(0, 8).map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">{c.employee_count}</td>
                    <td className="px-4 py-3">{c.admin_ai_enabled ? 'On' : 'Off'}</td>
                    <td className="px-4 py-3">{c.admin_email_crawl_enabled ? 'On' : 'Off'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/companies/${c.id}`} className="text-brand-600 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {companies.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-500">No companies yet.</p>
            ) : null}
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
