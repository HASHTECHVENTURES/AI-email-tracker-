import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { UsageBackfillService } from './usage-backfill.service';

export interface CompanyBillingRow {
  company_id: string;
  company_name: string;
  api_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  api_cost_usd: number;
  api_cost_inr: number;
  storage_bytes: number;
  storage_gb: number;
  storage_cost_usd: number;
  storage_cost_inr: number;
  total_cost_usd: number;
  total_cost_inr: number;
  message_count: number;
  conversation_count: number;
  employee_count: number;
}

export interface BillingOverview {
  currency: { usd_to_inr: number };
  rates: {
    gemini_input_usd_per_1m: number;
    gemini_output_usd_per_1m: number;
    storage_usd_per_gb_month: number;
  };
  period: { from: string; to: string };
  metering: {
    disclaimer: string;
    metered_since: string | null;
    live_api_calls: number;
    estimated_backfill_calls: number;
    storage_note: string;
  };
  platform_totals: {
    api_calls: number;
    total_tokens: number;
    api_cost_usd: number;
    api_cost_inr: number;
    storage_bytes: number;
    storage_cost_usd: number;
    storage_cost_inr: number;
    total_cost_usd: number;
    total_cost_inr: number;
  };
  companies: CompanyBillingRow[];
}

@Injectable()
export class CompanyBillingService {
  private readonly logger = new Logger(CompanyBillingService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
    private readonly usageBackfill: UsageBackfillService,
  ) {}

  private async loadBillingRates(): Promise<{
    gemini_input_usd_per_1m: number;
    gemini_output_usd_per_1m: number;
    storage_usd_per_gb_month: number;
    usd_to_inr: number;
  }> {
    const { data } = await this.supabase
      .from('system_settings')
      .select('key, value')
      .in('key', [
        'billing_gemini_input_usd_per_1m',
        'billing_gemini_output_usd_per_1m',
        'billing_storage_usd_per_gb_month',
        'billing_usd_to_inr',
      ]);

    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    return {
      gemini_input_usd_per_1m: Number(map.get('billing_gemini_input_usd_per_1m') ?? this.config.get('BILLING_GEMINI_INPUT_USD_PER_1M') ?? 0.3),
      gemini_output_usd_per_1m: Number(map.get('billing_gemini_output_usd_per_1m') ?? this.config.get('BILLING_GEMINI_OUTPUT_USD_PER_1M') ?? 2.5),
      storage_usd_per_gb_month: Number(map.get('billing_storage_usd_per_gb_month') ?? this.config.get('BILLING_STORAGE_USD_PER_GB_MONTH') ?? 0.125),
      usd_to_inr: Number(map.get('billing_usd_to_inr') ?? this.config.get('BILLING_USD_TO_INR') ?? 83),
    };
  }

  private monthBounds(): { from: string; to: string } {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: from.toISOString(), to: now.toISOString() };
  }

  async getBillingOverview(month?: string): Promise<BillingOverview> {
    await this.usageBackfill.ensureBackfill();

    const rates = await this.loadBillingRates();
    const period = this.resolvePeriod(month);
    const metering = await this.loadMeteringMeta(period.from, period.to);

    const { data: companies, error: companiesErr } = await this.supabase
      .from('companies')
      .select('id, name')
      .order('name');
    if (companiesErr) throw companiesErr;

    const companyRows = await Promise.all(
      (companies ?? []).map((c: { id: string; name: string }) =>
        this.buildCompanyBillingRow(c.id, c.name, period.from, period.to, rates),
      ),
    );

    const platform_totals = companyRows.reduce(
      (acc, row) => ({
        api_calls: acc.api_calls + row.api_calls,
        total_tokens: acc.total_tokens + row.total_tokens,
        api_cost_usd: acc.api_cost_usd + row.api_cost_usd,
        api_cost_inr: acc.api_cost_inr + row.api_cost_inr,
        storage_bytes: acc.storage_bytes + row.storage_bytes,
        storage_cost_usd: acc.storage_cost_usd + row.storage_cost_usd,
        storage_cost_inr: acc.storage_cost_inr + row.storage_cost_inr,
        total_cost_usd: acc.total_cost_usd + row.total_cost_usd,
        total_cost_inr: acc.total_cost_inr + row.total_cost_inr,
      }),
      {
        api_calls: 0,
        total_tokens: 0,
        api_cost_usd: 0,
        api_cost_inr: 0,
        storage_bytes: 0,
        storage_cost_usd: 0,
        storage_cost_inr: 0,
        total_cost_usd: 0,
        total_cost_inr: 0,
      },
    );

    return {
      currency: { usd_to_inr: rates.usd_to_inr },
      rates: {
        gemini_input_usd_per_1m: rates.gemini_input_usd_per_1m,
        gemini_output_usd_per_1m: rates.gemini_output_usd_per_1m,
        storage_usd_per_gb_month: rates.storage_usd_per_gb_month,
      },
      period,
      metering,
      platform_totals,
      companies: companyRows.sort((a, b) => b.total_cost_inr - a.total_cost_inr),
    };
  }

  private async loadMeteringMeta(
    from: string,
    to: string,
  ): Promise<BillingOverview['metering']> {
    const [liveCountRes, backfillCountRes, meteredSinceRes] = await Promise.all([
      this.supabase
        .from('api_usage_events')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', from)
        .lt('created_at', to)
        .neq('operation', 'backfill_estimate'),
      this.supabase
        .from('api_usage_events')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', from)
        .lt('created_at', to)
        .eq('operation', 'backfill_estimate'),
      this.supabase
        .from('api_usage_events')
        .select('created_at')
        .neq('operation', 'backfill_estimate')
        .order('created_at', { ascending: true })
        .limit(1),
    ]);

    const live_api_calls = liveCountRes.count ?? 0;
    const estimated_backfill_calls = backfillCountRes.count ?? 0;
    const metered_since =
      (meteredSinceRes.data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null;

    return {
      disclaimer:
        'Estimated tenant usage for invoicing. Live API rows are metered from each Gemini call; older AI-classified mail uses a token estimate (~800 in / ~45 out per message). Storage is approximate bytes in your database.',
      metered_since,
      live_api_calls,
      estimated_backfill_calls,
      storage_note: 'Storage = email bodies + subjects + conversation summaries (not full cloud infra bill).',
    };
  }

  async getCompanyBilling(companyId: string, month?: string): Promise<CompanyBillingRow | null> {
    const rates = await this.loadBillingRates();
    const period = this.resolvePeriod(month);
    const { data: company } = await this.supabase
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) return null;
    return this.buildCompanyBillingRow(company.id, company.name, period.from, period.to, rates);
  }

  private resolvePeriod(month?: string): { from: string; to: string } {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return this.monthBounds();
    }
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    return { from: from.toISOString(), to: to.toISOString() };
  }

  private async buildCompanyBillingRow(
    companyId: string,
    companyName: string,
    from: string,
    to: string,
    rates: { storage_usd_per_gb_month: number; usd_to_inr: number },
  ): Promise<CompanyBillingRow> {
    const [apiRes, storageRes, countsRes] = await Promise.all([
      this.supabase
        .from('api_usage_events')
        .select('prompt_tokens, output_tokens, total_tokens, estimated_cost_usd')
        .eq('company_id', companyId)
        .gte('created_at', from)
        .lt('created_at', to),
      this.supabase.rpc('company_storage_bytes', { p_company_id: companyId }),
      Promise.all([
        this.supabase.from('email_messages').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
        this.supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
        this.supabase.from('employees').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      ]),
    ]);

    const apiRows = (apiRes.data ?? []) as Array<{
      prompt_tokens: number;
      output_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number;
    }>;

    let api_calls = 0;
    let prompt_tokens = 0;
    let output_tokens = 0;
    let total_tokens = 0;
    let api_cost_usd = 0;
    for (const row of apiRows) {
      api_calls += 1;
      prompt_tokens += row.prompt_tokens ?? 0;
      output_tokens += row.output_tokens ?? 0;
      total_tokens += row.total_tokens ?? 0;
      api_cost_usd += Number(row.estimated_cost_usd ?? 0);
    }
    api_cost_usd = Math.round(api_cost_usd * 1_000_000) / 1_000_000;

    let storage_bytes = 0;
    if (storageRes.error) {
      storage_bytes = await this.fallbackStorageBytes(companyId);
    } else {
      storage_bytes = Number(storageRes.data ?? 0);
    }

    const storage_gb = storage_bytes / (1024 ** 3);
    const storage_cost_usd = Math.round(storage_gb * rates.storage_usd_per_gb_month * 1_000_000) / 1_000_000;
    const api_cost_inr = Math.round(api_cost_usd * rates.usd_to_inr * 100) / 100;
    const storage_cost_inr = Math.round(storage_cost_usd * rates.usd_to_inr * 100) / 100;
    const total_cost_usd = Math.round((api_cost_usd + storage_cost_usd) * 1_000_000) / 1_000_000;
    const total_cost_inr = Math.round((api_cost_inr + storage_cost_inr) * 100) / 100;

    return {
      company_id: companyId,
      company_name: companyName,
      api_calls,
      prompt_tokens,
      output_tokens,
      total_tokens,
      api_cost_usd,
      api_cost_inr,
      storage_bytes,
      storage_gb: Math.round(storage_gb * 1000) / 1000,
      storage_cost_usd,
      storage_cost_inr,
      total_cost_usd,
      total_cost_inr,
      message_count: countsRes[0].count ?? 0,
      conversation_count: countsRes[1].count ?? 0,
      employee_count: countsRes[2].count ?? 0,
    };
  }

  private async fallbackStorageBytes(companyId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('email_messages')
      .select('body_text, subject')
      .eq('company_id', companyId)
      .limit(5000);
    if (error) {
      this.logger.warn(`fallbackStorageBytes: ${error.message}`);
      return 0;
    }
    let bytes = 0;
    for (const row of data ?? []) {
      const r = row as { body_text?: string; subject?: string };
      bytes += new TextEncoder().encode((r.body_text ?? '') + (r.subject ?? '')).length;
    }
    return bytes;
  }
}
