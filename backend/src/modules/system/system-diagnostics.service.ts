import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { RequestContext } from '../common/request-context';
import { isGeminiEnvConfigured } from '../common/env';
import { SettingsService } from '../settings/settings.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';

type RecentIngestedRow = {
  employee_id: string;
  subject: string;
  direction: string;
  sent_at: string;
  ingested_at: string;
};

export type MailboxDiagnostic = {
  employee_id: string;
  name: string;
  email: string;
  department_id: string;
  gmail_status: string | null;
  has_oauth_token: boolean;
  tracking_paused: boolean;
  ai_enabled: boolean;
  tracking_start_at: string | null;
  portal_employee_login_linked: boolean;
  mail_sync_start_date: string | null;
  mail_sync_last_processed_at: string | null;
  email_message_count: number;
  conversation_count: number;
  /** Human-readable reasons mail may not become conversations */
  blockers: string[];
  hints: string[];
};

@Injectable()
export class SystemDiagnosticsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly settingsService: SettingsService,
    private readonly companyPolicyService: CompanyPolicyService,
  ) {}

  async run(ctx: RequestContext): Promise<{
    generated_at: string;
    environment: {
      gemini_configured: boolean;
      ingestion_cron_disabled: boolean;
      node_env: string | null;
    };
    settings: Awaited<ReturnType<SettingsService['getAll']>>;
    ingestion_runtime: Awaited<ReturnType<SettingsService['getRuntimeStatus']>>;
    totals: { email_messages: number; conversations: number };
    mailboxes: MailboxDiagnostic[];
    recent_ingested_messages: RecentIngestedRow[];
    /** Gates for Gemini during ingest — same logic as `EmailIngestionService` `allowGeminiRelevance` (per mailbox also needs `ai_enabled`). */
    inbox_ai_relevance: {
      gemini_key_configured: boolean;
      platform_company_ai_enabled: boolean;
      ceo_email_ai_relevance_enabled: boolean;
      mailboxes_ai_off: { name: string; email: string }[];
      would_run_for_all_mailboxes: boolean;
    };
    checklist: string[];
  }> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Diagnostics are available to CEO and department managers only');
    }

    const settings = await this.settingsService.getAll();
    const ingestion_runtime = await this.settingsService.getRuntimeStatus();
    const companyFlags = await this.companyPolicyService.getFlags(ctx.companyId);
    const geminiKeyOk = isGeminiEnvConfigured();
    const platformAiOk = companyFlags.admin_ai_enabled;
    const ceoInboxAiOk = settings.email_ai_relevance_enabled;

    let empQuery = this.supabase
      .from('employees')
      .select(
        'id, name, email, department_id, gmail_status, tracking_paused, ai_enabled, tracking_start_at, is_active',
      )
      .eq('company_id', ctx.companyId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId) {
        throw new ForbiddenException('Manager account has no department scope');
      }
      empQuery = empQuery.eq('department_id', ctx.departmentId);
    }

    const { data: emps, error: empErr } = await empQuery;
    if (empErr) {
      throw empErr;
    }

    const rows = (emps ?? []) as Array<{
      id: string;
      name: string;
      email: string;
      department_id: string;
      gmail_status: string | null;
      tracking_paused: boolean;
      ai_enabled: boolean;
      tracking_start_at: string | null;
    }>;

    const ids = rows.map((r) => r.id);
    const tokenSet = new Set<string>();
    const syncByEmp = new Map<string, { start_date: string; last_processed_at: string | null }>();
    const portalSet = new Set<string>();

    if (ids.length > 0) {
      const { data: tok } = await this.supabase
        .from('employee_oauth_tokens')
        .select('employee_id')
        .in('employee_id', ids);
      for (const t of tok ?? []) {
        tokenSet.add((t as { employee_id: string }).employee_id);
      }

      const { data: syncRows } = await this.supabase
        .from('mail_sync_state')
        .select('employee_id, start_date, last_processed_at')
        .in('employee_id', ids);
      for (const s of syncRows ?? []) {
        const r = s as { employee_id: string; start_date: string; last_processed_at: string | null };
        syncByEmp.set(r.employee_id, { start_date: r.start_date, last_processed_at: r.last_processed_at });
      }

      const { data: portalRows } = await this.supabase
        .from('users')
        .select('linked_employee_id')
        .eq('company_id', ctx.companyId)
        .eq('role', 'EMPLOYEE')
        .not('linked_employee_id', 'is', null)
        .in('linked_employee_id', ids);
      for (const p of portalRows ?? []) {
        portalSet.add((p as { linked_employee_id: string }).linked_employee_id);
      }
    }

    const { count: totalMsg } = await this.supabase
      .from('email_messages')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId);

    const { count: totalConv } = await this.supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId);

    const mailboxes: MailboxDiagnostic[] = [];
    for (const e of rows) {
      const portalLinked = portalSet.has(e.id);
      const hasOAuth = tokenSet.has(e.id);
      const sync = syncByEmp.get(e.id) ?? null;

      const { count: ec } = await this.supabase
        .from('email_messages')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', e.id);

      const { count: cc } = await this.supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('employee_id', e.id);

      const blockers: string[] = [];
      const hints: string[] = [];

      if (!hasOAuth) {
        blockers.push('No Gmail OAuth token for this mailbox — use Connect Gmail on the Employees page.');
      }
      if (e.tracking_paused) {
        blockers.push('Email fetch is paused for this mailbox (Team card / CEO table toggle).');
      }
      if (!settings.email_crawl_enabled) {
        blockers.push('Company-wide Email (Gmail fetch) is OFF in Settings.');
      }
      if (portalLinked && !settings.email_crawl_employee_mailboxes_enabled) {
        blockers.push('Company setting: Gmail fetch for employee-portal mailboxes is OFF.');
      }
      if (!portalLinked && !settings.email_crawl_team_mailboxes_enabled) {
        blockers.push('Company setting: Gmail fetch for team mailboxes is OFF.');
      }

      const trackingStart = e.tracking_start_at ? new Date(e.tracking_start_at) : null;
      if (trackingStart && !Number.isNaN(trackingStart.getTime())) {
        if (trackingStart.getTime() > Date.now() + 60_000) {
          blockers.push(
            `Tracking start is in the future (${trackingStart.toISOString()}) — messages sent before that time are skipped.`,
          );
        }
      }

      if (hasOAuth && (ec ?? 0) === 0 && !blockers.some((b) => b.includes('crawl'))) {
        hints.push(
          'No rows in email_messages yet for this mailbox — ingest may not have run, the Gmail window/query returned nothing yet, or every message was skipped (before tracking start or not relevant to store).',
        );
        if (sync?.start_date) {
          hints.push(
            `Gmail list uses after:${Math.floor(new Date(sync.start_date).getTime() / 1000)} (mail_sync_state.start_date — tracking start if set, otherwise connect time). Multi-page walks use a stored page token so older mail in that window is not skipped. Only Inbox/Sent after that instant match the query — check Promotions/Social if mail is missing.`,
          );
        }
      }
      if ((ec ?? 0) > 0 && (cc ?? 0) === 0) {
        hints.push(
          'Stored messages exist but no conversations — run recompute if needed, check for outbound-only rows, or threads still building. (Only relevance-kept mail is stored.)',
        );
      }
      if (e.ai_enabled === false) {
        hints.push(
          'Mailbox AI is OFF for this row — Inbox Gemini relevance is skipped. New mail is stored only if the CEO confirmed “import without Inbox AI” on My Email.',
        );
      }

      mailboxes.push({
        employee_id: e.id,
        name: e.name,
        email: e.email,
        department_id: e.department_id,
        gmail_status: e.gmail_status,
        has_oauth_token: hasOAuth,
        tracking_paused: e.tracking_paused === true,
        ai_enabled: e.ai_enabled !== false,
        tracking_start_at: e.tracking_start_at,
        portal_employee_login_linked: portalLinked,
        mail_sync_start_date: sync?.start_date ?? null,
        mail_sync_last_processed_at: sync?.last_processed_at ?? null,
        email_message_count: ec ?? 0,
        conversation_count: cc ?? 0,
        blockers,
        hints,
      });
    }

    const { data: recent } = await this.supabase
      .from('email_messages')
      .select('employee_id, subject, direction, sent_at, ingested_at')
      .eq('company_id', ctx.companyId)
      .order('ingested_at', { ascending: false })
      .limit(15);

    const mailboxesAiOff = rows
      .filter((r) => r.ai_enabled === false)
      .map((r) => ({ name: r.name, email: r.email }));
    const wouldRunForAll =
      geminiKeyOk &&
      platformAiOk &&
      ceoInboxAiOk &&
      mailboxesAiOff.length === 0;

    const checklist = [
      'Inbox Gemini — API host: set GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY). Without it, use My Email → confirm “import without Inbox AI” to store mail.',
      'Inbox Gemini — Platform Admin → Admin → your company → AI enabled ON (companies.admin_ai_enabled).',
      'Inbox Gemini — Settings (CEO) → AI master ON (includes email_ai_relevance_enabled).',
      'Inbox Gemini — Employees → each mailbox: AI ON (employees.ai_enabled). If OFF, ingest needs CEO confirmation on My Email.',
      'Inbox Gemini sees full message context (including Gmail category labels as a hint in the prompt) — relevance is model-decided, not pre-filtered by rules.',
      'Settings → company Email (Gmail fetch) master ON.',
      'Employees → mailbox Email fetch ON for that person (not paused).',
      'Tracking start must be BEFORE the test email’s sent time (timezone matters).',
      'Host: DISABLE_INGESTION_CRON must not be "true" for scheduled sync.',
      'After changing settings, wait ~2 minutes or use Settings → Run Gmail sync now (CEO).',
    ];

    return {
      generated_at: new Date().toISOString(),
      environment: {
        gemini_configured: geminiKeyOk,
        ingestion_cron_disabled: process.env.DISABLE_INGESTION_CRON === 'true',
        node_env: process.env.NODE_ENV ?? null,
      },
      settings,
      ingestion_runtime,
      totals: {
        email_messages: totalMsg ?? 0,
        conversations: totalConv ?? 0,
      },
      mailboxes,
      recent_ingested_messages: (recent ?? []) as RecentIngestedRow[],
      inbox_ai_relevance: {
        gemini_key_configured: geminiKeyOk,
        platform_company_ai_enabled: platformAiOk,
        ceo_email_ai_relevance_enabled: ceoInboxAiOk,
        mailboxes_ai_off: mailboxesAiOff,
        would_run_for_all_mailboxes: wouldRunForAll,
      },
      checklist,
    };
  }
}
