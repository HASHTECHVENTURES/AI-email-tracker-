import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

export type AiMode = 'AUTO' | 'MANUAL' | 'OFF';

export interface SystemSettings {
  ai_enabled: boolean;
  ai_mode: AiMode;
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
      return { ai_enabled: true, ai_mode: 'AUTO', default_sla_hours: 24 };
    }

    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const mode = (map.get('ai_mode') ?? 'AUTO').toUpperCase() as AiMode;
    const validModes: AiMode[] = ['AUTO', 'MANUAL', 'OFF'];
    const rawSla = Number(map.get('default_sla_hours') ?? '24');
    const default_sla_hours = Number.isFinite(rawSla) ? Math.min(168, Math.max(1, Math.round(rawSla))) : 24;
    return {
      ai_enabled: mode !== 'OFF' && map.get('ai_enabled') !== 'false',
      ai_mode: validModes.includes(mode) ? mode : 'AUTO',
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

  async getRuntimeStatus(): Promise<RuntimeStatus> {
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

    const lastReportAt = map.get('last_ai_report_at') ?? null;
    // No report yet → tie to next ingestion window; else hourly from last report (rolled forward)
    const nextReportAt = lastReportAt
      ? alignNext(lastReportAt, REPORT_INTERVAL_SECONDS)
      : nextIngestionAt;

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

  async tryAcquireIngestionLock(maxLockMinutes = 30): Promise<boolean> {
    const runtime = await this.getRuntimeStatus();
    const startedAtMs = runtime.lastIngestionStartedAt
      ? new Date(runtime.lastIngestionStartedAt).getTime()
      : 0;
    const lockAgeMs = Date.now() - startedAtMs;
    const isStale = !startedAtMs || lockAgeMs > maxLockMinutes * 60_000;

    if (runtime.ingestionRunning && !isStale) {
      return false;
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
  }> {
    const [runtime, settings, employeeCount] = await Promise.all([
      this.getRuntimeStatus(),
      this.getAll(),
      this.supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('is_active', true),
    ]);
    return {
      is_active: true,
      last_sync_at: runtime.lastIngestionFinishedAt,
      employees_tracked: employeeCount.count ?? 0,
      ai_status: settings.ai_enabled,
    };
  }
}
