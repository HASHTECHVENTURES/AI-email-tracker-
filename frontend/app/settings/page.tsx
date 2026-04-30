'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { isDepartmentManagerRole } from '@/lib/roles';
import { AppShell } from '@/components/AppShell';
import { PortalPageLoader } from '@/components/PortalPageLoader';

type Me = { role: string; company_name?: string | null };
type Settings = {
  ai_enabled: boolean;
  email_ai_relevance_enabled: boolean;
  email_ingest_without_ai_confirmed: boolean;
  gemini_api_key_configured: boolean;
  company_admin_ai_enabled?: boolean;
  company_admin_email_crawl_enabled?: boolean;
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

type DiagnosticsMailbox = {
  name: string;
  email: string;
  has_oauth_token: boolean;
  tracking_paused: boolean;
  email_message_count: number;
  conversation_count: number;
  tracking_start_at: string | null;
  mail_sync_start_date: string | null;
  mail_sync_last_processed_at: string | null;
  portal_employee_login_linked: boolean;
  blockers: string[];
  hints: string[];
};

type DiagnosticsPayload = {
  generated_at: string;
  environment: {
    gemini_configured: boolean;
    ingestion_cron_disabled: boolean;
    node_env: string | null;
  };
  totals: { email_messages: number; conversations: number };
  mailboxes: DiagnosticsMailbox[];
  recent_ingested_messages: Array<{
    employee_id: string;
    subject: string;
    direction: string;
    sent_at: string;
    ingested_at: string;
  }>;
  inbox_ai_relevance: {
    gemini_key_configured: boolean;
    platform_company_ai_enabled: boolean;
    ceo_email_ai_relevance_enabled: boolean;
    mailboxes_ai_off: { name: string; email: string }[];
    would_run_for_all_mailboxes: boolean;
  };
  checklist: string[];
};

export default function SettingsPage() {
  const router = useRouter();
  const { me: authMe, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatusLite | null>(null);
  const [slaDraft, setSlaDraft] = useState('');
  const [savingSla, setSavingSla] = useState(false);
  const [savingMasterCombined, setSavingMasterCombined] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsPayload | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  /** Avoids showing master toggles as OFF before GET /settings returns (was a visible flash). */
  const [settingsLoadState, setSettingsLoadState] = useState<'pending' | 'ready' | 'failed'>('pending');
  const hadSuccessfulSettingsFetch = useRef(false);
  const settingsLoadStateRef = useRef(settingsLoadState);
  useEffect(() => {
    settingsLoadStateRef.current = settingsLoadState;
  }, [settingsLoadState]);

  const load = useCallback(async (token: string) => {
    if (settingsLoadStateRef.current === 'failed') setError(null);
    setSettingsLoadState((s) => (s === 'failed' ? 'pending' : s));
    const [sRes, rRes, sysRes] = await Promise.all([
      apiFetch('/settings', token),
      apiFetch('/settings/runtime', token),
      apiFetch('/system/status', token),
    ]);
    if (sRes.ok) {
      const s = (await sRes.json()) as Settings;
      hadSuccessfulSettingsFetch.current = true;
      setSettings({
        ...s,
        email_ai_relevance_enabled: s.email_ai_relevance_enabled !== false,
        email_ingest_without_ai_confirmed: s.email_ingest_without_ai_confirmed === true,
        gemini_api_key_configured: s.gemini_api_key_configured !== false,
        company_admin_ai_enabled: s.company_admin_ai_enabled !== false,
        company_admin_email_crawl_enabled: s.company_admin_email_crawl_enabled !== false,
        email_crawl_enabled: s.email_crawl_enabled !== false,
        ai_for_managers_enabled: s.ai_for_managers_enabled !== false,
        ai_for_employees_enabled: s.ai_for_employees_enabled !== false,
        email_crawl_team_mailboxes_enabled: s.email_crawl_team_mailboxes_enabled !== false,
        email_crawl_employee_mailboxes_enabled: s.email_crawl_employee_mailboxes_enabled !== false,
      });
      setSlaDraft(String(s.default_sla_hours ?? 24));
      setSettingsLoadState('ready');
    } else {
      setSettingsLoadState((prev) => (prev === 'pending' ? 'failed' : prev));
      setError(
        hadSuccessfulSettingsFetch.current
          ? 'Could not refresh settings. Your saved values are unchanged.'
          : 'Could not load company settings.',
      );
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
    if (authMe.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    setMe(authMe as Me);
    void load(token);
  }, [authLoading, authMe, token, router, load]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const res = await apiFetch('/platform-admin/me', token);
      if (res.ok) {
        const b = (await res.json()) as { allowed?: boolean };
        setPlatformAdmin(b.allowed === true);
      } else {
        setPlatformAdmin(false);
      }
    })();
  }, [token]);

  const platformEmailAllowed = settings?.company_admin_email_crawl_enabled !== false;
  const platformAiAllowed = settings?.company_admin_ai_enabled !== false;
  const platformOverrideOff = !platformEmailAllowed || !platformAiAllowed;

  const masterEmailOn = useMemo(() => {
    if (!settings) return false;
    return (
      platformEmailAllowed &&
      settings.email_crawl_enabled !== false &&
      settings.email_crawl_team_mailboxes_enabled !== false &&
      settings.email_crawl_employee_mailboxes_enabled !== false
    );
  }, [settings, platformEmailAllowed]);

  const masterAiOn = useMemo(() => {
    if (!settings) return false;
    return (
      platformAiAllowed &&
      Boolean(settings.ai_enabled) &&
      settings.email_ai_relevance_enabled !== false &&
      settings.ai_for_managers_enabled !== false &&
      settings.ai_for_employees_enabled !== false
    );
  }, [settings, platformAiAllowed]);

  /** Single CEO switch: both Gmail fetch and company AI are on, or not. */
  const masterCombinedOn = useMemo(() => masterEmailOn && masterAiOn, [masterEmailOn, masterAiOn]);
  const masterMixed = useMemo(
    () => settingsLoadState === 'ready' && settings != null && masterEmailOn !== masterAiOn,
    [settingsLoadState, settings, masterEmailOn, masterAiOn],
  );

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

  async function setMasterCombined() {
    if (!me || me.role !== 'CEO' || !token) return;
    const next = !masterCombinedOn;
    if (next && platformOverrideOff) {
      setError('Platform Admin has disabled Email and/or AI for this company. CEO settings cannot override it.');
      return;
    }
    setError(null);
    setNotice(null);
    setSavingMasterCombined(true);
    try {
      const res = await apiFetch('/settings/masters', token, {
        method: 'PUT',
        body: JSON.stringify({ email: next, ai: next }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError((b.message as string) || 'Could not update company master');
        return;
      }
      setNotice(
        next
          ? 'Gmail fetch and AI are now on for the company.'
          : 'Gmail fetch and AI are now off for the company.',
      );
      await load(token);
    } finally {
      setSavingMasterCombined(false);
    }
  }

  async function runDiagnostics() {
    if (!token) return;
    setDiagError(null);
    setDiagLoading(true);
    try {
      const res = await apiFetch('/system/diagnostics', token);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDiagError((body as { message?: string }).message || 'Diagnostics failed');
        setDiag(null);
        return;
      }
      setDiag(body as DiagnosticsPayload);
    } finally {
      setDiagLoading(false);
    }
  }

  async function runGmailSyncNow() {
    if (!me || me.role !== 'CEO' || !token) return;
    setError(null);
    setNotice(null);
    setSyncLoading(true);
    try {
      const res = await apiFetch('/email-ingestion/run', token);
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        reason?: string;
        message?: string;
        results?: Array<{ employeeName?: string; newMessages?: number; error?: string }>;
      };
      if (!res.ok) {
        setError((body as { message?: string }).message || 'Sync request failed');
        return;
      }
      if (body.status === 'skipped') {
        setNotice(body.message || 'Sync skipped — turn on Email & AI in Settings.');
      } else {
        const r = body.results ?? [];
        const msgs = r.reduce((s, x) => s + (x.newMessages ?? 0), 0);
        const errs = r.filter((x) => x.error).length;
        setNotice(
          `Sync finished: ${r.length} mailbox(es), ${msgs} new message(s) processed${errs ? `, ${errs} with issues` : ''}.`,
        );
      }
      await load(token);
    } finally {
      setSyncLoading(false);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell
        role={me?.role ?? shellRoleHint ?? 'EMPLOYEE'}
        title="Settings"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }
  const isHead = isDepartmentManagerRole(me.role);
  const isCeo = me.role === 'CEO';

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={authMe?.full_name?.trim() || authMe?.email}
      title="Settings"
      subtitle={isHead ? 'View system status. Company defaults are CEO-only.' : 'Company defaults and system status.'}
      lastSyncLabel={sysStatus?.last_sync_at ? new Date(sysStatus.last_sync_at).toLocaleString() : null}
      isActive={sysStatus?.is_active}
      aiBriefingsEnabled={sysStatus == null ? undefined : sysStatus.ai_status}
      mailboxCrawlEnabled={sysStatus == null ? undefined : sysStatus.email_crawl_enabled}
      onRefresh={() => {
        if (token) void load(token);
      }}
      onSignOut={() => void ctxSignOut()}
    >
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

      {platformAdmin ? (
        <section className="rounded-xl border border-violet-200/80 bg-gradient-to-r from-violet-50 to-indigo-50/90 p-5 shadow-sm">
          <Link
            href="/admin"
            className="text-base font-semibold text-violet-900 underline-offset-2 hover:underline"
          >
            Platform administration
          </Link>
        </section>
      ) : null}

      <section
        className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]"
        aria-busy={settingsLoadState === 'pending'}
      >
        <h2 className="text-base font-semibold text-slate-900">Email &amp; AI</h2>
        <p className="mt-1 max-w-xl text-sm text-slate-500">
          One control for the whole company: Gmail fetch (all mailboxes) and AI (relevance, summaries, reports) stay
          aligned — both on or both off.
        </p>
        {settingsLoadState === 'ready' && platformOverrideOff ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Platform Admin override is active:
            {!platformEmailAllowed ? ' Email crawl is disabled.' : ''}
            {!platformAiAllowed ? ' AI is disabled.' : ''}
            {' '}CEO settings cannot turn these back on until the admin kill switch is enabled.
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm font-medium text-slate-700">
            {settingsLoadState === 'pending' ? (
              <span className="text-slate-400">Loading…</span>
            ) : settingsLoadState === 'failed' ? (
              <span className="text-amber-800">—</span>
            ) : masterMixed ? (
              <span className="text-amber-800">Mixed — use the switch to set both on or both off.</span>
            ) : (
              <span>{masterCombinedOn ? 'On' : 'Off'}</span>
            )}
          </div>
          {isCeo ? (
            settingsLoadState === 'pending' ? (
              <div
                className="h-8 w-14 animate-pulse rounded-full bg-slate-200"
                aria-hidden
                title="Loading settings"
              />
            ) : settingsLoadState === 'failed' ? (
              <span className="text-xs text-red-600">Load failed</span>
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={masterMixed ? 'mixed' : masterCombinedOn}
                disabled={savingMasterCombined || platformOverrideOff}
                onClick={() => void setMasterCombined()}
                className={`relative h-8 w-14 rounded-full transition-colors ${masterCombinedOn ? 'bg-indigo-600' : 'bg-slate-200'} ${savingMasterCombined || platformOverrideOff ? 'opacity-50' : ''}`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${masterCombinedOn ? 'left-7' : 'left-1'}`}
                />
              </button>
            )
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
              disabled={!isCeo || settingsLoadState !== 'ready'}
              className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </div>
          {isCeo ? (
            <button
              type="button"
              onClick={() => void saveSla()}
              disabled={savingSla || settingsLoadState !== 'ready'}
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
        {settingsLoadState === 'ready' && !masterEmailOn ? (
          <p className="mt-2 text-sm text-amber-800">
            Gmail fetch is off (Email &amp; AI master) — scheduled cycles skip Gmail until the CEO turns it back on.
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
            {runtime?.lastIngestionFinishedAt ? new Date(runtime.lastIngestionFinishedAt).toLocaleString() : '—'}
          </li>
        </ul>
        {isCeo ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void runGmailSyncNow()}
              disabled={syncLoading || settingsLoadState !== 'ready' || !masterEmailOn}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              {syncLoading ? 'Running sync…' : 'Run Gmail sync now'}
            </button>
            <p className="mt-2 text-xs text-slate-500">
              Triggers one ingestion cycle immediately (same as the ~2 min scheduler). Requires company Email master on.
            </p>
          </div>
        ) : null}
      </section>

      {isCeo && (
        <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-sm shadow-slate-900/[0.02]">
          <h2 className="text-base font-semibold text-slate-900">Mail troubleshooting</h2>
          <p className="mt-1 text-sm text-slate-500">
            See why Gmail may not appear on dashboards: OAuth, pauses, company crawl flags, tracking start date, and recent ingested
            messages.
          </p>
          <button
            type="button"
            onClick={() => void runDiagnostics()}
            disabled={diagLoading}
            className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {diagLoading ? 'Loading…' : 'Run diagnostics'}
          </button>
          {diagError ? <p className="mt-3 text-sm text-red-600">{diagError}</p> : null}
          {diag ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="rounded-lg bg-slate-50 p-3 text-slate-700">
                <p className="font-medium text-slate-900">Environment</p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
                  <li>Gemini configured: {diag.environment.gemini_configured ? 'yes' : 'no'} (needed for Inbox AI relevance)</li>
                  <li>
                    Ingestion cron disabled:{' '}
                    {diag.environment.ingestion_cron_disabled
                      ? 'yes — scheduled sync is off (unset DISABLE_INGESTION_CRON on the API host)'
                      : 'no'}
                  </li>
                </ul>
              </div>
              {diag.inbox_ai_relevance ? (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-slate-800">
                  <p className="font-medium text-indigo-950">Inbox AI (Gemini) — “should we care about this email?”</p>
                  <p className="mt-1 text-xs text-slate-600">
                    All of the below must be OK for each mailbox so Gemini can classify incoming mail (including recent
                    thread context). If Inbox AI cannot run, use My Email to confirm importing without AI or fix the red
                    items below.
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs">
                    <li className="flex flex-wrap gap-x-2">
                      <span className={diag.inbox_ai_relevance.gemini_key_configured ? 'text-emerald-700' : 'text-red-700'}>
                        {diag.inbox_ai_relevance.gemini_key_configured ? '✓' : '✗'} API key on server
                      </span>
                      <span className="text-slate-500">(GEMINI_API_KEY or alternates in .env)</span>
                    </li>
                    <li className={diag.inbox_ai_relevance.platform_company_ai_enabled ? 'text-emerald-700' : 'text-red-700'}>
                      {diag.inbox_ai_relevance.platform_company_ai_enabled ? '✓' : '✗'} Platform Admin → company AI enabled
                    </li>
                    <li className={diag.inbox_ai_relevance.ceo_email_ai_relevance_enabled ? 'text-emerald-700' : 'text-red-700'}>
                      {diag.inbox_ai_relevance.ceo_email_ai_relevance_enabled ? '✓' : '✗'} CEO Settings → AI master ON (includes Inbox AI)
                    </li>
                    {diag.inbox_ai_relevance.mailboxes_ai_off.length > 0 ? (
                      <li className="text-amber-900">
                        ✗ AI OFF on {diag.inbox_ai_relevance.mailboxes_ai_off.length} mailbox(es):{' '}
                        {diag.inbox_ai_relevance.mailboxes_ai_off.map((m) => m.name || m.email).join(', ')} — turn AI on under Employees
                      </li>
                    ) : (
                      <li className="text-emerald-700">✓ All mailboxes have AI enabled</li>
                    )}
                  </ul>
                  <p className="mt-2 text-xs font-medium text-indigo-900">
                    {diag.inbox_ai_relevance.would_run_for_all_mailboxes
                      ? 'Gemini inbox relevance can run for every mailbox on the next sync.'
                      : 'Fix the red/amber items above, then run sync again.'}
                  </p>
                </div>
              ) : null}
              <div>
                <p className="font-medium text-slate-900">Totals</p>
                <p className="mt-1 text-slate-600">
                  {diag.totals.email_messages} email message row(s), {diag.totals.conversations} conversation(s) in this company.
                </p>
              </div>
              <div>
                <p className="font-medium text-slate-900">Checklist</p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-slate-600">
                  {diag.checklist.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium text-slate-900">Per mailbox</p>
                <ul className="mt-2 space-y-3">
                  {diag.mailboxes.map((m) => (
                    <li key={m.email} className="rounded-lg border border-slate-100 p-3">
                      <p className="font-medium text-slate-800">
                        {m.name} · {m.email}
                      </p>
                      <p className="text-xs text-slate-500">
                        OAuth: {m.has_oauth_token ? 'yes' : 'no'} · Paused: {m.tracking_paused ? 'yes' : 'no'} · Messages:{' '}
                        {m.email_message_count} · Conversations: {m.conversation_count}
                        {m.tracking_start_at
                          ? ` · Tracking since (inbox window): ${new Date(m.tracking_start_at).toLocaleString()}`
                          : ''}
                        {m.mail_sync_start_date
                          ? ` · Gmail fetch “after”: ${new Date(m.mail_sync_start_date).toLocaleString()} (set at Connect Gmail — only newer mail is listed)`
                          : ''}
                        {m.mail_sync_last_processed_at
                          ? ` · Last cursor: ${new Date(m.mail_sync_last_processed_at).toLocaleString()}`
                          : ''}
                        {m.portal_employee_login_linked ? ' · Portal-linked mailbox' : ' · Team mailbox'}
                      </p>
                      {m.blockers.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-xs text-red-700">
                          {m.blockers.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      ) : null}
                      {m.hints.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-xs text-amber-800">
                          {m.hints.map((h, i) => (
                            <li key={i}>{h}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
              {diag.recent_ingested_messages.length > 0 ? (
                <div>
                  <p className="font-medium text-slate-900">Recent ingested (latest 15)</p>
                  <ul className="mt-2 max-h-48 overflow-auto text-xs text-slate-600">
                    {diag.recent_ingested_messages.map((r, i) => (
                      <li key={i} className="border-b border-slate-100 py-1">
                        <span className="text-slate-400">{new Date(r.ingested_at).toLocaleString()}</span> · {r.direction} ·{' '}
                        {(r.subject || '(no subject)').slice(0, 80)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-amber-800">No rows in email_messages yet for this company — sync may not have stored anything.</p>
              )}
            </div>
          ) : null}
        </section>
      )}
    </AppShell>
  );
}
