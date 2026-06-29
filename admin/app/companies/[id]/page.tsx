'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { FlagSwitch, PageHeader, StatCard, StatusPill } from '@/components/admin/ui';
import { formatBytes, formatDate, formatInr, formatUsd } from '@/lib/admin/format';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';
import type { CompanyBillingRow, CompanyDetail } from '@/lib/admin/types';

export default function AdminCompanyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = String(params.id ?? '');
  const { allowed, loading, me, signOut, token } = usePlatformAdmin(`/companies/${companyId}`);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [billing, setBilling] = useState<CompanyBillingRow | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pending, setPending] = useState<'ai' | 'email' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    if (!token || !companyId) return;
    setPageLoading(true);
    const [dRes, bRes] = await Promise.all([
      apiFetch(`/platform-admin/companies/${encodeURIComponent(companyId)}/detail`, token),
      apiFetch(`/platform-admin/billing/${encodeURIComponent(companyId)}`, token),
    ]);
    if (dRes.ok) setDetail((await dRes.json()) as CompanyDetail);
    if (bRes.ok) setBilling((await bRes.json()) as CompanyBillingRow);
    setPageLoading(false);
  }, [token, companyId]);

  useEffect(() => {
    if (allowed && token) void load();
  }, [allowed, token, load]);

  async function patchFlags(patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean }) {
    if (!token || !detail || savingRef.current) return;
    savingRef.current = true;
    setPending(patch.admin_ai_enabled !== undefined ? 'ai' : 'email');
    const snapshot = detail;
    setDetail({ ...detail, ...patch });
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(companyId)}/flags`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) setDetail(snapshot);
    } finally {
      savingRef.current = false;
      setPending(null);
    }
  }

  async function removeCompany() {
    if (!token || !detail) return;
    if (!window.confirm(`Delete "${detail.name}" and all data? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(companyId)}`, token, {
        method: 'DELETE',
      });
      if (res.ok) router.push('/companies');
    } finally {
      setDeleting(false);
    }
  }

  if (loading || pageLoading) {
    return (
      <AdminShell title="Company" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false || !detail) return null;

  return (
    <AdminShell title={detail.name} userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <div className="mb-4">
        <Link href="/companies" className="text-sm text-brand-600 hover:underline">
          ← All companies
        </Link>
      </div>

      <PageHeader
        title={detail.name}
        description={`Created ${formatDate(detail.created_at)} · ${detail.totals.employees} mailboxes · ${detail.totals.conversations} conversations`}
      />

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Messages stored" value={detail.totals.messages.toLocaleString()} />
        <StatCard label="AI classified" value={detail.ai_usage.ai_classified_messages.toLocaleString()} />
        <StatCard label="Connected mailboxes" value={detail.totals.connected_mailboxes} />
        <StatCard label="Departments" value={detail.totals.departments} />
      </div>

      {billing ? (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Billing (this month)</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="API cost" value={formatInr(billing.api_cost_inr)} sub={formatUsd(billing.api_cost_usd)} />
            <StatCard label="Storage" value={formatBytes(billing.storage_bytes)} sub={formatInr(billing.storage_cost_inr)} />
            <StatCard label="Total charge" value={formatInr(billing.total_cost_inr)} accent="text-brand-600" />
            <StatCard label="API calls" value={billing.api_calls} sub={`${billing.total_tokens.toLocaleString()} tokens`} />
          </div>
        </section>
      ) : null}

      <section className="mb-8 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">Platform controls</h2>
        <div className="flex flex-wrap gap-8">
          <div className="flex items-center gap-3">
            <FlagSwitch
              checked={detail.admin_ai_enabled}
              busy={pending === 'ai'}
              title="AI"
              onToggle={() => void patchFlags({ admin_ai_enabled: !detail.admin_ai_enabled })}
            />
            <div>
              <p className="text-sm font-medium text-slate-800">AI classification</p>
              <StatusPill on={detail.admin_ai_enabled} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FlagSwitch
              checked={detail.admin_email_crawl_enabled}
              busy={pending === 'email'}
              title="Crawl"
              onToggle={() => void patchFlags({ admin_email_crawl_enabled: !detail.admin_email_crawl_enabled })}
            />
            <div>
              <p className="text-sm font-medium text-slate-800">Email crawl</p>
              <StatusPill on={detail.admin_email_crawl_enabled} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => void removeCompany()}
            disabled={deleting}
            className="ml-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete company'}
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Mailboxes</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Gmail</th>
                <th className="px-4 py-3 text-right">Msgs</th>
                <th className="px-4 py-3 text-right">Convos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {detail.employees.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{e.name}</div>
                    <div className="text-xs text-slate-500">{e.email}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{e.department_name ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{e.gmail_status ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{e.message_count}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{e.conversation_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Portal users</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {detail.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3">{u.role}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
