'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminShell } from '@/components/admin/AdminShell';
import { PageHeader } from '@/components/admin/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { usePlatformAdmin } from '@/lib/admin/use-platform-admin';
import { apiFetch } from '@/lib/api';

export default function AdminNewCompanyPage() {
  const router = useRouter();
  const { allowed, loading, me, signOut, token } = usePlatformAdmin('/admin/companies/new');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !name.trim()) return;
    setCreating(true);
    setError(null);
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
      const created = (await res.json()) as { id?: string };
      router.push(created.id ? `/admin/companies/${created.id}` : '/admin/companies');
    } finally {
      setCreating(false);
    }
  }

  if (loading || allowed === false) return null;

  return (
    <AdminShell title="Add company" userDisplayName={me?.full_name ?? me?.email} onSignOut={() => void signOut()}>
      <PageHeader
        title="Provision a new tenant"
        description="Creates an isolated company. Optionally add a CEO login in the same step."
      />
      {error ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      <form onSubmit={handleSubmit} className="max-w-lg space-y-4 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Company name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
            placeholder="Acme Corp"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          CEO email <span className="text-slate-400">(optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          CEO password <span className="text-slate-400">(optional)</span>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
            autoComplete="new-password"
          />
        </label>
        <button
          type="submit"
          disabled={creating}
          className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create company'}
        </button>
      </form>
    </AdminShell>
  );
}
