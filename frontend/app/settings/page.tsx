'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';

type Me = { role: string; company_name?: string | null };
type Settings = {
  ai_enabled: boolean;
  email_ai_relevance_enabled: boolean;
  email_crawl_enabled: boolean;
  ai_for_managers_enabled: boolean;
  ai_for_employees_enabled: boolean;
  email_crawl_team_mailboxes_enabled: boolean;
  email_crawl_employee_mailboxes_enabled: boolean;
  default_sla_hours: number;
};
type Runtime = { ingestionRunning: boolean; lastIngestionStatus: string; lastIngestionFinishedAt: string | null };
type SystemStatusLite = {
  is_active: boolean;
  ai_status: boolean;
  email_crawl_enabled: boolean;
  last_sync_at: string | null;
};

export default function SettingsPage() {
  const router = useRouter();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatusLite | null>(null);
  const [slaDraft, setSlaDraft] = useState('');
  const [savingSla, setSavingSla] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [savingEmailAi, setSavingEmailAi] = useState(false);
  const [savingCrawl, setSavingCrawl] = useState(false);
  const [roleSavingKey, setRoleSavingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (token: string) => {
    const [sRes, rRes, sysRes] = await Promise.all([
      apiFetch('/settings', token),
      apiFetch('/settings/runtime', token),
      apiFetch('/system/status', token),
    ]);
    if (sRes.ok) {
      const s = (await sRes.json()) as Settings;
      setSettings({
        ...s,
        email_ai_relevance_enabled: s.email_ai_relevance_enabled !== false,
        email_crawl_enabled: s.email_crawl_enabled !== false,
        ai_for_managers_enabled: s.ai_for_managers_enabled !== false,
        ai_for_employees_enabled: s.ai_for_employees_enabled !== false,
        email_crawl_team_mailboxes_enabled: s.email_crawl_team_mailboxes_enabled !== false,
        email_crawl_employee_mailboxes_enabled: s.email_crawl_employee_mailboxes_enabled !== false,
      });
      setSlaDraft(String(s.default_sla_hours ?? 24));
    }
    if (rRes.ok) setRuntime((await rRes.json()) as Runtime);
    if (sysRes.ok) {
      const b = (await sysRes.json()) as SystemStatusLite;
      setSysStatus({
        is_active: Boolean(b.is_active),
        ai_status: b.ai_status !== false,
        email_crawl_enabled: b.email_crawl_enabled !== false,
        last_sync_at: b.last_sync_at ?? null,
      });
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!authMe || !token) {
      router.replace('/auth');
      return;
    }
    setMe(authMe as Me);
    void load(token);
  }, [authLoading, authMe, token, router, load]);

  async function saveSla() {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    const n = Number(slaDraft);
    if (!Number.isFinite(n) || n < 1 || n > 168) {
      setError('SLA must be between 1 and 168 hours.');
      return;
    }
    setSavingSla(true);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ key: 'default_sla_hours', value: String(Math.round(n)) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not save SLA');
        return;
      }
      setNotice('Default SLA updated.');
      await load(token);
    } finally {
      setSavingSla(false);
    }
  }

  async function setAiEnabled(next: boolean) {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    setSavingAi(true);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ key: 'ai_mode', value: next ? 'AUTO' : 'OFF' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update AI setting');
        return;
      }
      setNotice(next ? 'AI operations on.' : 'AI operations off (reports & thread enrichment paused).');
      await load(token);
    } finally {
      setSavingAi(false);
    }
  }

  async function saveRoleSetting(key: string, next: boolean, success: string) {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    setRoleSavingKey(key);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ key, value: next ? 'true' : 'false' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not save setting');
        return;
      }
      setNotice(success);
      await load(token);
    } finally {
      setRoleSavingKey(null);
    }
  }

  async function setMailboxCrawl(next: boolean) {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    setSavingCrawl(true);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ key: 'email_crawl_enabled', value: next ? 'true' : 'false' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update mailbox crawl setting');
        return;
      }
      setNotice(
        next
          ? 'Mailbox crawl on — scheduled Gmail fetch will run again.'
          : 'Mailbox crawl off — automatic Gmail fetch is paused (turn on to resume).',
      );
      await load(token);
    } finally {
      setSavingCrawl(false);
    }
  }

  async function setEmailAiRelevance(next: boolean) {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    setSavingEmailAi(true);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ key: 'email_ai_relevance_enabled', value: next ? 'true' : 'false' }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update inbox AI setting');
        return;
      }
      setNotice(next ? 'Inbox AI classification on.' : 'Inbox AI off — using rules only for new mail.');
      await load(token);
    } finally {
      setSavingEmailAi(false);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell role="CEO" title="Settings" subtitle="Loading…" onSignOut={() => void ctxSignOut()}>
        <PageSkeleton />
      </AppShell>
    );
  }
  const isHead = me.role === 'HEAD' || me.role === 'MANAGER';
  const isCeo = me.role === 'CEO';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      title="Settings"
      subtitle={isHead ? 'View system status. Company defaults are CEO-only.' : 'Company defaults and system status.'}
      lastSyncLabel={sysStatus?.last_sync_at ? new Date(sysStatus.last_sync_at).toLocaleString() : null}
      isActive={sysStatus?.is_active}
      aiBriefingsEnabled={sysStatus == null ? undefined : sysStatus.ai_status}
      mailboxCrawlEnabled={sysStatus == null ? undefined : sysStatus.email_crawl_enabled}
      onRefresh={() => { if (token) void load(token); }}
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">AI operations</h2>
        <p className="mt-1 text-sm text-slate-500">
          Executive / department AI reports and Gemini enrichment on conversation threads. Does not stop Gmail fetch — use <strong className="font-medium">Mailbox crawl</strong> below to pause ingestion.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm font-medium text-slate-700">
            {settings?.ai_enabled ? 'On' : 'Off'}
          </span>
          {isCeo ? (
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(settings?.ai_enabled)}
              disabled={savingAi}
              onClick={() => void setAiEnabled(!settings?.ai_enabled)}
              className={`relative h-8 w-14 rounded-full transition-colors ${settings?.ai_enabled ? 'bg-indigo-600' : 'bg-slate-200'} ${savingAi ? 'opacity-50' : ''}`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.ai_enabled ? 'left-7' : 'left-1'}`}
              />
            </button>
          ) : (
            <span className="text-xs text-slate-400">CEO only</span>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Mailbox crawl (Gmail fetch)</h2>
        <p className="mt-1 text-sm text-slate-500">
          When off, the app does not fetch new mail from connected mailboxes (scheduled runs every 2 minutes and CEO “run ingestion” both stop). Existing data stays in the dashboard.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm font-medium text-slate-700">
            {settings?.email_crawl_enabled !== false ? 'On' : 'Off'}
          </span>
          {isCeo ? (
            <button
              type="button"
              role="switch"
              aria-checked={settings?.email_crawl_enabled !== false}
              disabled={savingCrawl}
              onClick={() => void setMailboxCrawl(!(settings?.email_crawl_enabled !== false))}
              className={`relative h-8 w-14 rounded-full transition-colors ${settings?.email_crawl_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${savingCrawl ? 'opacity-50' : ''}`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.email_crawl_enabled !== false ? 'left-7' : 'left-1'}`}
              />
            </button>
          ) : (
            <span className="text-xs text-slate-400">CEO only</span>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Managers & employees</h2>
        <p className="mt-1 text-sm text-slate-500">
          Fine-grained controls when company-wide AI and mailbox crawl are on. <strong className="font-medium text-slate-600">Team mailbox</strong> means a
          tracked mailbox with no Employee portal user linked to it. <strong className="font-medium text-slate-600">Employee portal mailbox</strong> is linked
          to a user with role Employee.
        </p>
        <ul className="mt-4 space-y-5">
          <li className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4 last:border-0 last:pb-0">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium text-slate-800">AI for department managers</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Department head dashboard briefings, AI reports, and thread enrichment for team mailboxes.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-medium text-slate-700">
                {settings?.ai_for_managers_enabled !== false ? 'On' : 'Off'}
              </span>
              {isCeo ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.ai_for_managers_enabled !== false}
                  disabled={roleSavingKey !== null}
                  onClick={() =>
                    void saveRoleSetting(
                      'ai_for_managers_enabled',
                      !(settings?.ai_for_managers_enabled !== false),
                      !(settings?.ai_for_managers_enabled !== false)
                        ? 'AI for department managers is on.'
                        : 'AI for department managers is off.',
                    )
                  }
                  className={`relative h-8 w-14 rounded-full transition-colors ${settings?.ai_for_managers_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${roleSavingKey ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.ai_for_managers_enabled !== false ? 'left-7' : 'left-1'}`}
                  />
                </button>
              ) : (
                <span className="text-xs text-slate-400">CEO only</span>
              )}
            </div>
          </li>
          <li className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4 last:border-0 last:pb-0">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium text-slate-800">AI for employee portal mailboxes</p>
              <p className="mt-0.5 text-xs text-slate-500">Thread enrichment for mailboxes tied to an Employee login.</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-medium text-slate-700">
                {settings?.ai_for_employees_enabled !== false ? 'On' : 'Off'}
              </span>
              {isCeo ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.ai_for_employees_enabled !== false}
                  disabled={roleSavingKey !== null}
                  onClick={() =>
                    void saveRoleSetting(
                      'ai_for_employees_enabled',
                      !(settings?.ai_for_employees_enabled !== false),
                      !(settings?.ai_for_employees_enabled !== false)
                        ? 'AI for employee mailboxes is on.'
                        : 'AI for employee mailboxes is off.',
                    )
                  }
                  className={`relative h-8 w-14 rounded-full transition-colors ${settings?.ai_for_employees_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${roleSavingKey ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.ai_for_employees_enabled !== false ? 'left-7' : 'left-1'}`}
                  />
                </button>
              ) : (
                <span className="text-xs text-slate-400">CEO only</span>
              )}
            </div>
          </li>
          <li className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4 last:border-0 last:pb-0">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium text-slate-800">Gmail fetch — team mailboxes</p>
              <p className="mt-0.5 text-xs text-slate-500">Fetch new mail for tracked mailboxes without an Employee portal link.</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-medium text-slate-700">
                {settings?.email_crawl_team_mailboxes_enabled !== false ? 'On' : 'Off'}
              </span>
              {isCeo ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.email_crawl_team_mailboxes_enabled !== false}
                  disabled={roleSavingKey !== null}
                  onClick={() =>
                    void saveRoleSetting(
                      'email_crawl_team_mailboxes_enabled',
                      !(settings?.email_crawl_team_mailboxes_enabled !== false),
                      !(settings?.email_crawl_team_mailboxes_enabled !== false)
                        ? 'Team mailbox Gmail fetch is on.'
                        : 'Team mailbox Gmail fetch is off.',
                    )
                  }
                  className={`relative h-8 w-14 rounded-full transition-colors ${settings?.email_crawl_team_mailboxes_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${roleSavingKey ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.email_crawl_team_mailboxes_enabled !== false ? 'left-7' : 'left-1'}`}
                  />
                </button>
              ) : (
                <span className="text-xs text-slate-400">CEO only</span>
              )}
            </div>
          </li>
          <li className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-md">
              <p className="text-sm font-medium text-slate-800">Gmail fetch — employee portal mailboxes</p>
              <p className="mt-0.5 text-xs text-slate-500">Fetch new mail only for mailboxes linked to an Employee login.</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-medium text-slate-700">
                {settings?.email_crawl_employee_mailboxes_enabled !== false ? 'On' : 'Off'}
              </span>
              {isCeo ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.email_crawl_employee_mailboxes_enabled !== false}
                  disabled={roleSavingKey !== null}
                  onClick={() =>
                    void saveRoleSetting(
                      'email_crawl_employee_mailboxes_enabled',
                      !(settings?.email_crawl_employee_mailboxes_enabled !== false),
                      !(settings?.email_crawl_employee_mailboxes_enabled !== false)
                        ? 'Employee portal mailbox Gmail fetch is on.'
                        : 'Employee portal mailbox Gmail fetch is off.',
                    )
                  }
                  className={`relative h-8 w-14 rounded-full transition-colors ${settings?.email_crawl_employee_mailboxes_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${roleSavingKey ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.email_crawl_employee_mailboxes_enabled !== false ? 'left-7' : 'left-1'}`}
                  />
                </button>
              ) : (
                <span className="text-xs text-slate-400">CEO only</span>
              )}
            </div>
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Inbox AI (email enrichment)</h2>
        <p className="mt-1 text-sm text-slate-500">
          When on, new Gmail messages are classified with AI to decide if they become tracked conversations. When off, only built-in rules and exclude patterns apply.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm font-medium text-slate-700">
            {settings?.email_ai_relevance_enabled !== false ? 'On' : 'Off'}
          </span>
          {isCeo ? (
            <button
              type="button"
              role="switch"
              aria-checked={settings?.email_ai_relevance_enabled !== false}
              disabled={savingEmailAi}
              onClick={() => void setEmailAiRelevance(!(settings?.email_ai_relevance_enabled !== false))}
              className={`relative h-8 w-14 rounded-full transition-colors ${settings?.email_ai_relevance_enabled !== false ? 'bg-indigo-600' : 'bg-slate-200'} ${savingEmailAi ? 'opacity-50' : ''}`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${settings?.email_ai_relevance_enabled !== false ? 'left-7' : 'left-1'}`}
              />
            </button>
          ) : (
            <span className="text-xs text-slate-400">CEO only</span>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Default SLA</h2>
        <p className="mt-1 text-sm text-slate-500">Hours before a follow-up is treated as overdue (when not overridden per mailbox).</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="sla-hours" className="mb-1 block text-xs font-medium text-slate-500">
              Hours
            </label>
            <input
              id="sla-hours"
              type="number"
              min={1}
              max={168}
              value={slaDraft}
              onChange={(e) => setSlaDraft(e.target.value)}
              disabled={!isCeo}
              className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </div>
          {isCeo ? (
            <button
              type="button"
              onClick={() => void saveSla()}
              disabled={savingSla}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {savingSla ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <span className="text-xs text-slate-400">CEO only</span>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
        <h2 className="text-base font-semibold text-slate-900">Ingestion</h2>
        {settings?.email_crawl_enabled === false ? (
          <p className="mt-2 text-sm text-amber-800">
            Mailbox crawl is off — scheduled cycles skip Gmail until you turn it back on.
          </p>
        ) : null}
        <ul className="mt-3 space-y-2 text-sm text-slate-600">
          <li className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${runtime?.ingestionRunning ? 'bg-amber-500' : 'bg-slate-300'}`} />
            {runtime?.ingestionRunning ? 'Running' : 'Idle'}
          </li>
          <li>Last status: {runtime?.lastIngestionStatus ?? '—'}</li>
          <li>
            Last finished:{' '}
            {runtime?.lastIngestionFinishedAt
              ? new Date(runtime.lastIngestionFinishedAt).toLocaleString()
              : '—'}
          </li>
        </ul>
      </section>
    </AppShell>
  );
}
