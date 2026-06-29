'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { PageHeader, StatCard } from '@/components/admin/ui';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';

type ActivityData = {
  email_volume: { today: number; this_week: number; this_month: number; total: number };
  ai_usage: { classified_today: number; classified_week: number; classified_month: number; skipped_today: number };
  employee_breakdown: Array<{
    employee_name: string;
    employee_email: string;
    company_name: string;
    total_messages: number;
    messages_today: number;
    conversations: number;
  }>;
};

export default function AdminActivityPage() {
  const { allowed, loading, me, signOut, token } = usePlatformAdmin('/activity');
  const [data, setData] = useState<ActivityData | null>(null);
  const [actLoading, setActLoading] = useState(true);

  useEffect(() => {
    if (!token || !allowed) return;
    void apiFetch('/platform-admin/activity', token).then(async (res) => {
      if (res.ok) setData((await res.json()) as ActivityData);
      setActLoading(false);
    });
  }, [token, allowed]);

  if (loading) {
    return (
      <AdminShell title="Activity" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) return null;

  return (
    <AdminShell title="Activity" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="Platform activity"
        description="Email ingestion and AI classification across all tenants (IST day boundaries)."
      />
      {actLoading || !data ? (
        <PortalPageLoader variant="embedded" />
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Ingested today" value={data.email_volume.today} />
            <StatCard label="This week" value={data.email_volume.this_week} />
            <StatCard label="AI classified today" value={data.ai_usage.classified_today} accent="text-violet-600" />
            <StatCard label="AI skipped today" value={data.ai_usage.skipped_today} accent="text-amber-600" />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3 text-right">Today</th>
                  <th className="px-4 py-3 text-right">Total msgs</th>
                  <th className="px-4 py-3 text-right">Convos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {data.employee_breakdown
                  .sort((a, b) => b.messages_today - a.messages_today)
                  .slice(0, 50)
                  .map((e) => (
                    <tr key={`${e.company_name}-${e.employee_email}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{e.employee_name}</div>
                        <div className="text-xs text-slate-500">{e.employee_email}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{e.company_name}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{e.messages_today}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{e.total_messages}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{e.conversations}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
