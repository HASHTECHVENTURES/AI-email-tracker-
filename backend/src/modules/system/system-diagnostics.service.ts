import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { RequestContext } from '../common/request-context';
import { SettingsService } from '../settings/settings.service';

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
    checklist: string[];
  }> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Diagnostics are available to CEO and department managers only');
    }

    const settings = await this.settingsService.getAll();
    const ingestion_runtime = await this.settingsService.getRuntimeStatus();

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
          'No rows in email_messages yet for this mailbox — Gmail may have returned no new IDs (cursor, query filters) or ingest has not run since connect.',
        );
        if (sync?.start_date) {
          hints.push(
            `Gmail list uses after:${Math.floor(new Date(sync.start_date).getTime() / 1000)} (from mail_sync_state.start_date, set when Gmail was connected). Only messages in Inbox/Sent after that instant are fetched — send yourself a new test mail after that time, or check Promotions/Social (excluded by query).`,
          );
        }
      }
      if ((ec ?? 0) > 0 && (cc ?? 0) === 0) {
        hints.push(
          'Messages are ingested but there are no conversations — likely filtered as not relevant (rules/Inbox AI) or only outbound mail.',
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

    const checklist = [
      'Deploy latest API (Gmail Updates + public-domain heuristic fixes).',
      'Settings → company Email master ON.',
      'Employees → mailbox Email fetch ON for that person.',
      'Tracking start must be BEFORE the test email’s sent time (timezone matters).',
      'Railway: DISABLE_INGESTION_CRON must not be "true".',
      'After changing settings, wait ~2 minutes or trigger GET /email-ingestion/run (CEO) once.',
    ];

    return {
      generated_at: new Date().toISOString(),
      environment: {
        gemini_configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
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
      checklist,
    };
  }
}
