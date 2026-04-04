import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

export type AiMode = 'AUTO' | 'MANUAL' | 'OFF';

export interface SystemSettings {
  ai_enabled: boolean;
  ai_mode: AiMode;
  /** Gemini-based relevance during Gmail ingest (vs heuristics only). Independent of ai_enabled. */
  email_ai_relevance_enabled: boolean;
  /** Scheduled + manual Gmail fetch / ingestion cycles. When false, no mailboxes are crawled. */
  email_crawl_enabled: boolean;
  /** AI for HEAD users (dept reports, dashboard snapshot) and team mailboxes (not portal-linked). */
  ai_for_managers_enabled: boolean;
  /** AI for employee-portal–linked mailboxes (users.role EMPLOYEE + linked_employee_id). */
  ai_for_employees_enabled: boolean;
  /** Gmail fetch for team mailboxes (no EMPLOYEE portal user linked to that employee row). */
  email_crawl_team_mailboxes_enabled: boolean;
  /** Gmail fetch for mailboxes linked to an Employee portal login. */
  email_crawl_employee_mailboxes_enabled: boolean;
  /** Fallback SLA (hours) when an employee has no personal override */
  default_sla_hours: number;
}

export interface RuntimeStatus {
  ingestionRunning: boolean;
  lastIngestionStartedAt: string | null;
  lastIngestionFinishedAt: string | null;
  lastIngestionStatus: 'success' | 'failed' | 'idle';
  lastIngestionError: string | null;
  lastIngestionEmployees: number;
  lastIngestionMessages: number;
  ingestionIntervalSeconds: number;
  nextIngestionAt: string | null;
  reportIntervalSeconds: number;
  lastReportAt: string | null;
  nextReportAt: string | null;
  /** Seconds until next report window (server clock); UI decrements locally between polls. */
  secondsUntilNextReport: number | null;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async getAll(): Promise<SystemSettings> {
    const { data, error } = await this.supabase
      .from('system_settings')
      .select('key, value');

    if (error) {
      this.logger.error('Failed to load settings', error.message);
      return {
        ai_enabled: true,
        ai_mode: 'AUTO',
        email_ai_relevance_enabled: true,
        email_crawl_enabled: true,
        ai_for_managers_enabled: true,
        ai_for_employees_enabled: true,
        email_crawl_team_mailboxes_enabled: true,
        email_crawl_employee_mailboxes_enabled: true,
        default_sla_hours: 24,
      };
    }

    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const mode = (map.get('ai_mode') ?? 'AUTO').toUpperCase() as AiMode;
    const validModes: AiMode[] = ['AUTO', 'MANUAL', 'OFF'];
    const rawSla = Number(map.get('default_sla_hours') ?? '24');
    const default_sla_hours = Number.isFinite(rawSla) ? Math.min(168, Math.max(1, Math.round(rawSla))) : 24;
    return {
      ai_enabled: mode !== 'OFF' && map.get('ai_enabled') !== 'false',
      ai_mode: validModes.includes(mode) ? mode : 'AUTO',
      email_ai_relevance_enabled: map.get('email_ai_relevance_enabled') !== 'false',
      email_crawl_enabled: map.get('email_crawl_enabled') !== 'false',
      ai_for_managers_enabled: map.get('ai_for_managers_enabled') !== 'false',
      ai_for_employees_enabled: map.get('ai_for_employees_enabled') !== 'false',
      email_crawl_team_mailboxes_enabled: map.get('email_crawl_team_mailboxes_enabled') !== 'false',
      email_crawl_employee_mailboxes_enabled: map.get('email_crawl_employee_mailboxes_enabled') !== 'false',
      default_sla_hours,
    };
  }

  /** Used by follow-up logic when employee has no `sla_hours_default`. */
  async getDefaultSlaHours(): Promise<number> {
    const s = await this.getAll();
    return s.default_sla_hours;
  }

  async set(key: string, value: string): Promise<void> {
    const { error } = await this.supabase
      .from('system_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    if (error) {
      this.logger.error(`Failed to set ${key}`, error.message);
      throw error;
    }
  }

  async setMany(pairs: Array<{ key: string; value: string }>): Promise<void> {
    if (pairs.length === 0) return;
    const rows = pairs.map((p) => ({
      key: p.key,
      value: p.value,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await this.supabase
      .from('system_settings')
      .upsert(rows, { onConflict: 'key' });
    if (error) {
      this.logger.error('Failed to set many settings', error.message);
      throw error;
    }
  }

  /**
   * CEO master switches: `email` toggles all Gmail crawl keys together;
   * `ai` toggles AI mode, Inbox AI, manager/employee AI flags together.
   */
  async setCompanyMasters(opts: { email?: boolean; ai?: boolean }): Promise<void> {
    const pairs: Array<{ key: string; value: string }> = [];
    if (opts.email !== undefined) {
      const v = opts.email ? 'true' : 'false';
      pairs.push(
        { key: 'email_crawl_enabled', value: v },
        { key: 'email_crawl_team_mailboxes_enabled', value: v },
        { key: 'email_crawl_employee_mailboxes_enabled', value: v },
      );
    }
    if (opts.ai !== undefined) {
      if (opts.ai) {
        pairs.push(
          { key: 'ai_mode', value: 'AUTO' },
          { key: 'ai_enabled', value: 'true' },
          { key: 'email_ai_relevance_enabled', value: 'true' },
          { key: 'ai_for_managers_enabled', value: 'true' },
          { key: 'ai_for_employees_enabled', value: 'true' },
        );
      } else {
        pairs.push(
          { key: 'ai_mode', value: 'OFF' },
          { key: 'ai_enabled', value: 'false' },
          { key: 'email_ai_relevance_enabled', value: 'false' },
          { key: 'ai_for_managers_enabled', value: 'false' },
          { key: 'ai_for_employees_enabled', value: 'false' },
        );
      }
    }
    await this.setMany(pairs);
  }

  async getRuntimeStatus(companyId?: string): Promise<RuntimeStatus> {
    const { data, error } = await this.supabase
      .from('system_settings')
      .select('key, value');

    if (error) {
      this.logger.error('Failed to load runtime status', error.message);
      return {
        ingestionRunning: false,
        lastIngestionStartedAt: null,
        lastIngestionFinishedAt: null,
        lastIngestionStatus: 'idle',
        lastIngestionError: null,
        lastIngestionEmployees: 0,
        lastIngestionMessages: 0,
        ingestionIntervalSeconds: 120,
        nextIngestionAt: null,
        reportIntervalSeconds: 3600,
        lastReportAt: null,
        nextReportAt: null,
        secondsUntilNextReport: null,
      };
    }

    const INGESTION_INTERVAL_SECONDS = 120;
    const REPORT_INTERVAL_SECONDS = 3600;

    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

    const lastFinished = map.get('last_ingestion_finished_at') ?? null;
    /** Next tick strictly after `now` so the UI always gets a positive countdown. */
    const alignNext = (anchorIso: string, intervalSec: number): string => {
      const stepMs = intervalSec * 1000;
      if (stepMs <= 0) return new Date(Date.now() + 60_000).toISOString();
      let t = new Date(anchorIso).getTime() + stepMs;
      const now = Date.now();
      let guard = 0;
      while (t <= now && guard++ < 5000) t += stepMs;
      return new Date(t).toISOString();
    };

    const nextIngestionAt = lastFinished
      ? alignNext(lastFinished, INGESTION_INTERVAL_SECONDS)
      : null;

    const lastReportAt = companyId
      ? map.get(`last_ai_report_at_${companyId}`) ?? map.get('last_ai_report_at') ?? null
      : map.get('last_ai_report_at') ?? null;
    // No report yet -> start hourly window from "now"; else hourly from last report (rolled forward)
    const nextReportAt = lastReportAt
      ? alignNext(lastReportAt, REPORT_INTERVAL_SECONDS)
      : alignNext(new Date().toISOString(), REPORT_INTERVAL_SECONDS);

    const serverNow = Date.now();
    const nextReportMs = nextReportAt ? new Date(nextReportAt).getTime() : NaN;
    const secondsUntilNextReport =
      nextReportAt != null && !Number.isNaN(nextReportMs)
        ? Math.max(0, Math.ceil((nextReportMs - serverNow) / 1000))
        : null;

    return {
      ingestionRunning: map.get('ingestion_running') === 'true',
      lastIngestionStartedAt: map.get('last_ingestion_started_at') ?? null,
      lastIngestionFinishedAt: lastFinished,
      lastIngestionStatus:
        (map.get('last_ingestion_status') as 'success' | 'failed' | 'idle' | undefined) ?? 'idle',
      lastIngestionError: map.get('last_ingestion_error') ?? null,
      lastIngestionEmployees: Number(map.get('last_ingestion_employees') ?? '0'),
      lastIngestionMessages: Number(map.get('last_ingestion_messages') ?? '0'),
      ingestionIntervalSeconds: INGESTION_INTERVAL_SECONDS,
      nextIngestionAt,
      reportIntervalSeconds: REPORT_INTERVAL_SECONDS,
      lastReportAt,
      nextReportAt,
      secondsUntilNextReport,
    };
  }

  async markIngestionStarted(): Promise<void> {
    await this.setMany([
      { key: 'ingestion_running', value: 'true' },
      { key: 'last_ingestion_started_at', value: new Date().toISOString() },
      { key: 'last_ingestion_error', value: '' },
    ]);
  }

  async tryAcquireIngestionLock(maxLockMinutes = 5): Promise<boolean> {
    const runtime = await this.getRuntimeStatus();
    const startedAtMs = runtime.lastIngestionStartedAt
      ? new Date(runtime.lastIngestionStartedAt).getTime()
      : 0;
    const lockAgeMs = Date.now() - startedAtMs;
    const isStale = !startedAtMs || lockAgeMs > maxLockMinutes * 60_000;

    if (runtime.ingestionRunning && !isStale) {
      return false;
    }

    if (runtime.ingestionRunning && isStale) {
      this.logger.warn(
        `Recovering stale ingestion lock (age: ${Math.round(lockAgeMs / 1000)}s)`,
      );
    }

    await this.markIngestionStarted();
    return true;
  }

  async markIngestionFinished(result: {
    status: 'success' | 'failed';
    error?: string;
    employees: number;
    messages: number;
  }): Promise<void> {
    await this.setMany([
      { key: 'ingestion_running', value: 'false' },
      { key: 'last_ingestion_finished_at', value: new Date().toISOString() },
      { key: 'last_ingestion_status', value: result.status },
      { key: 'last_ingestion_error', value: result.error ?? '' },
      { key: 'last_ingestion_employees', value: String(result.employees) },
      { key: 'last_ingestion_messages', value: String(result.messages) },
    ]);
  }

  async getSystemStatus(companyId: string): Promise<{
    is_active: boolean;
    last_sync_at: string | null;
    employees_tracked: number;
    ai_status: boolean;
    ai_for_managers_enabled: boolean;
    email_crawl_enabled: boolean;
    seconds_until_next_ingestion: number | null;
    last_report_at: string | null;
    seconds_until_next_report: number | null;
    smtp_configured: boolean;
    ai_model_configured: boolean;
  }> {
    const [runtime, settings, tracked] = await Promise.all([
      this.getRuntimeStatus(companyId),
      this.getAll(),
      this.countActiveEmployeesWithOAuth(companyId),
    ]);
    const lastSyncAt = runtime.lastIngestionFinishedAt;
    // Align with upstream repo: do not mark inactive just because last sync is >5m ago
    // (cron is every 2m; locks/Gemini latency can exceed a short window). Only treat as
    // inactive when the last ingestion cycle explicitly failed.
    const ingestionFailed = runtime.lastIngestionStatus === 'failed';
    const smtpConfigured = Boolean(
      process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim(),
    );
    const aiModelConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
    const nextIngestionMs = runtime.nextIngestionAt
      ? new Date(runtime.nextIngestionAt).getTime()
      : NaN;
    const secondsUntilNextIngestion =
      settings.email_crawl_enabled &&
      runtime.nextIngestionAt != null &&
      !Number.isNaN(nextIngestionMs)
        ? Math.max(0, Math.ceil((nextIngestionMs - Date.now()) / 1000))
        : null;
    return {
      is_active: !ingestionFailed,
      last_sync_at: lastSyncAt,
      employees_tracked: tracked,
      ai_status: settings.ai_enabled,
      ai_for_managers_enabled: settings.ai_for_managers_enabled,
      email_crawl_enabled: settings.email_crawl_enabled,
      seconds_until_next_ingestion: secondsUntilNextIngestion,
      // Always expose last run time so CEOs can see history while AI is off; countdown only when AI is on.
      last_report_at: runtime.lastReportAt,
      seconds_until_next_report: settings.ai_enabled ? runtime.secondsUntilNextReport : null,
      smtp_configured: smtpConfigured,
      ai_model_configured: aiModelConfigured,
    };
  }

  private async countActiveEmployeesWithOAuth(companyId: string): Promise<number> {
    const { data: emps, error } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_active', true);
    if (error || !emps?.length) return 0;
    const ids = (emps as { id: string }[]).map((e) => e.id);
    const { data: tokens } = await this.supabase
      .from('employee_oauth_tokens')
      .select('employee_id')
      .in('employee_id', ids);
    return new Set((tokens ?? []).map((t: { employee_id: string }) => t.employee_id)).size;
  }
}
