'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import { PasswordInput } from '@/components/PasswordInput';

type Stats = {
  companies_registered: number;
  total_users: number;
  total_employees: number;
  total_conversations: number;
  companies_with_ai_off: number;
  companies_with_email_crawl_off: number;
};

type CompanyRow = {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  user_count: number;
  employee_count: number;
};

/** Animated switch — thumb slides on `transform` only (smooth compositor animation). */
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

export default function PlatformAdminPage() {
  const router = useRouter();
  const { me, token, loading: authLoading, signOut } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [ceoEmail, setCeoEmail] = useState('');
  const [ceoPassword, setCeoPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Only the checkbox being saved is disabled — avoids both boxes in a row freezing together. */
  const [pendingFlagPatch, setPendingFlagPatch] = useState<{
    id: string;
    field: 'ai' | 'email';
  } | null>(null);
  /** Prevents double-fires before React state updates (sync). */
  const savingFlagKeysRef = useRef<Set<string>>(new Set());

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
    if (cRes.ok) setCompanies(((await cRes.json()) as CompanyRow[]) ?? []);
    setError(null);
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      router.replace('/auth?next=/admin');
      return;
    }
    setLoading(true);
    void load();
  }, [authLoading, token, router, load]);

  async function createCompany(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: newName.trim() };
      if (ceoEmail.trim() && ceoPassword) {
        body.ceo_email = ceoEmail.trim();
        body.ceo_password = ceoPassword;
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
      setNewName('');
      setCeoEmail('');
      setCeoPassword('');
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function patchFlags(
    id: string,
    patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean },
  ) {
    if (!token) return;
    const field: 'ai' | 'email' =
      patch.admin_ai_enabled !== undefined ? 'ai' : 'email';

    const lockKey = `${id}:${field}`;
    if (savingFlagKeysRef.current.has(lockKey)) return;
    savingFlagKeysRef.current.add(lockKey);

    const snapshot = companies;
    setPendingFlagPatch({ id, field });
    setError(null);

    // Optimistic update so the switch doesn’t snap back while the request runs.
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
    if (
      !window.confirm(
        `Delete company "${name}" and all related data? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/platform-admin/companies/${encodeURIComponent(id)}`, token, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Delete failed');
        return;
      }
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  if (authLoading || loading) {
    return (
      <AppShell role={me?.role ?? 'CEO'} title="Platform admin" subtitle="Loading…" onSignOut={() => void signOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }

  if (allowed === false) {
    return (
      <AppShell
        role={me?.role ?? 'CEO'}
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
      role={me?.role ?? 'CEO'}
      companyName={me?.company_name ?? null}
      userDisplayName={me?.full_name?.trim() || me?.email}
      title="Platform admin"
      subtitle="Companies registered in the system, KPIs, and per-tenant kill switches for AI and email ingestion."
      onSignOut={() => void signOut()}
    >
      <p className="text-sm text-slate-500">
        <Link href="/settings" className="font-medium text-brand-600 hover:underline">
          Settings
        </Link>
        {' · '}
        <Link href="/dashboard" className="font-medium text-brand-600 hover:underline">
          Dashboard
        </Link>
      </p>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      {stats ? (
        <section>
          <h2 className="mb-3 text-lg font-bold text-slate-900">System KPIs</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'Companies', value: stats.companies_registered },
              { label: 'Users', value: stats.total_users },
              { label: 'Tracked mailboxes', value: stats.total_employees },
              { label: 'Conversations', value: stats.total_conversations },
              { label: 'AI off (tenants)', value: stats.companies_with_ai_off },
              { label: 'Email crawl off', value: stats.companies_with_email_crawl_off },
            ].map((k) => (
              <div
                key={k.label}
                className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{k.label}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{k.value}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-card">
        <h2 className="text-lg font-bold text-slate-900">Add company</h2>
        <p className="mt-1 text-sm text-slate-500">
          Create an empty organization, or optionally provision a CEO login (requires API service role).
        </p>
        <form onSubmit={createCompany} className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
            Company name
            <input
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            CEO email (optional)
            <input
              type="email"
              value={ceoEmail}
              onChange={(e) => setCeoEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            CEO password (optional)
            <PasswordInput
              value={ceoPassword}
              onChange={(e) => setCeoPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-900 shadow-sm"
              autoComplete="new-password"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={creating}
              className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create company'}
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold text-slate-900">Companies</h2>
        <div className="overflow-x-auto rounded-2xl border border-slate-200/60 bg-white shadow-card">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Users</th>
                <th className="px-4 py-3">Mailboxes</th>
                <th className="px-4 py-3">AI allowed</th>
                <th className="px-4 py-3">Email ingest</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{c.user_count}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{c.employee_count}</td>
                  <td className="px-4 py-3">
                    <FlagSwitch
                      checked={c.admin_ai_enabled}
                      busy={pendingFlagPatch?.id === c.id && pendingFlagPatch.field === 'ai'}
                      title="Platform kill switch: AI enrichment and executive reports"
                      onToggle={() =>
                        void patchFlags(c.id, { admin_ai_enabled: !c.admin_ai_enabled })
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <FlagSwitch
                      checked={c.admin_email_crawl_enabled}
                      busy={pendingFlagPatch?.id === c.id && pendingFlagPatch.field === 'email'}
                      title="Platform kill switch: Gmail ingestion for this tenant"
                      onToggle={() =>
                        void patchFlags(c.id, {
                          admin_email_crawl_enabled: !c.admin_email_crawl_enabled,
                        })
                      }
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void removeCompany(c.id, c.name)}
                      disabled={deletingId === c.id}
                      className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingId === c.id ? 'Deleting…' : 'Delete'}
                    </button>
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

      <section className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">Kill switches</p>
        <p className="mt-1 text-amber-800/90">
          Unchecking <strong>AI allowed</strong> disables AI enrichment and scheduled executive reports for that tenant.
          Unchecking <strong>Email ingest</strong> skips Gmail sync for all mailboxes in that company. Global settings in
          CEO Settings still apply on top of these.
        </p>
      </section>
    </AppShell>
  );
}
