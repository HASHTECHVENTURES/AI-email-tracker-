'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { FlagSwitch, PageHeader, StatusPill } from '@/components/admin/ui';
import { portalLoginRolesLine } from '@/lib/admin/format';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';

export default function AdminCompaniesPage() {
  const {
    allowed,
    loading,
    companies,
    setCompanies,
    me,
    signOut,
    token,
    error,
    setError,
    reload,
  } = usePlatformAdmin('/admin/companies');
  const [pending, setPending] = useState<{ id: string; field: 'ai' | 'email' } | null>(null);
  const savingRef = useRef<Set<string>>(new Set());

  async function patchFlags(
    id: string,
    patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean },
  ) {
    if (!token) return;
    const field: 'ai' | 'email' = patch.admin_ai_enabled !== undefined ? 'ai' : 'email';
    const lockKey = `${id}:${field}`;
    if (savingRef.current.has(lockKey)) return;
    savingRef.current.add(lockKey);
    setPending({ id, field });
    const snapshot = companies;
    setCompanies((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(id)}/flags`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setCompanies(snapshot);
        setError('Could not update company flags.');
      }
    } finally {
      savingRef.current.delete(lockKey);
      setPending(null);
    }
  }

  if (loading) {
    return (
      <AdminShell title="Companies" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
        <PortalPageLoader variant="embedded" />
      </AdminShell>
    );
  }

  if (allowed === false) return null;

  return (
    <AdminShell title="Companies" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="All tenants"
        description="Each row is a separate company on the platform. Open a company for mailboxes, users, and billing."
      />
      {error ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Portal logins</th>
              <th className="px-4 py-3">Mailboxes</th>
              <th className="px-4 py-3">AI</th>
              <th className="px-4 py-3">Email crawl</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {companies.map((c) => {
              const roleLine = portalLoginRolesLine(c.portal_login_roles);
              return (
                <tr key={c.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-400">Since {new Date(c.created_at).toLocaleDateString()}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <div className="font-medium tabular-nums">{c.user_count}</div>
                    {roleLine ? <div className="text-[11px] text-slate-500">{roleLine}</div> : null}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{c.employee_count}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FlagSwitch
                        checked={c.admin_ai_enabled}
                        busy={pending?.id === c.id && pending.field === 'ai'}
                        title="AI classification"
                        onToggle={() => void patchFlags(c.id, { admin_ai_enabled: !c.admin_ai_enabled })}
                      />
                      <StatusPill on={c.admin_ai_enabled} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FlagSwitch
                        checked={c.admin_email_crawl_enabled}
                        busy={pending?.id === c.id && pending.field === 'email'}
                        title="Email crawl"
                        onToggle={() =>
                          void patchFlags(c.id, { admin_email_crawl_enabled: !c.admin_email_crawl_enabled })
                        }
                      />
                      <StatusPill on={c.admin_email_crawl_enabled} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/companies/${c.id}`} className="font-medium text-brand-600 hover:underline">
                      Manage →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {companies.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No companies yet.</p> : null}
      </div>
      <button type="button" onClick={() => void reload()} className="mt-4 text-sm text-slate-500 hover:text-slate-800">
        Refresh list
      </button>
    </AdminShell>
  );
}
