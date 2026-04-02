'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

type Me = { role: string; company_name?: string | null };
type Settings = { ai_enabled: boolean; default_sla_hours: number };
type Runtime = { ingestionRunning: boolean; lastIngestionStatus: string; lastIngestionFinishedAt: string | null };

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return router.replace('/auth');
      const meRes = await apiFetch('/auth/me', session.access_token);
      if (!meRes.ok) return router.replace('/auth');
      setMe((await meRes.json()) as Me);
      const [sRes, rRes] = await Promise.all([apiFetch('/settings', session.access_token), apiFetch('/settings/runtime', session.access_token)]);
      if (sRes.ok) setSettings((await sRes.json()) as Settings);
      if (rRes.ok) setRuntime((await rRes.json()) as Runtime);
    })();
  }, [router]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/auth');
  }

  if (!me) return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Settings"
      subtitle={
        isHead
          ? 'View company defaults and runtime status. Changing SLA or AI toggles is CEO-only today.'
          : 'Control AI defaults and monitor system runtime.'
      }
      onSignOut={() => void signOut()}
    >
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">AI Control</h2>
        <p className="mt-2 text-sm text-gray-600">AI enrichment is currently <span className="font-medium">{settings?.ai_enabled ? 'Enabled' : 'Disabled'}</span>.</p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">SLA Setting</h2>
        <p className="mt-2 text-sm text-gray-600">Default SLA: <span className="font-medium">{settings?.default_sla_hours ?? 24}h</span></p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">System Info</h2>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          <li>Ingestion running: {runtime?.ingestionRunning ? 'Yes' : 'No'}</li>
          <li>Last status: {runtime?.lastIngestionStatus ?? 'unknown'}</li>
          <li>Last sync: {runtime?.lastIngestionFinishedAt ? new Date(runtime.lastIngestionFinishedAt).toLocaleString() : 'n/a'}</li>
        </ul>
      </section>
    </AppShell>
  );
}
