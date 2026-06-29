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
  live_api_calls: number;
  estimated_api_calls: number;
  live_api_cost_inr: number;
  estimated_api_cost_inr: number;
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
    backfill_calibration: number;
  };
  period: { from: string; to: string };
  metering: {
    disclaimer: string;
    metered_since: string | null;
    live_api_calls: number;
    estimated_backfill_calls: number;
    storage_note: string;
    calibration_note: string;
  };
  platform_totals: {
    api_calls: number;
    total_tokens: number;
    api_cost_usd: number;
    api_cost_inr: number;
    live_api_calls: number;
    estimated_api_calls: number;
    live_api_cost_inr: number;
    estimated_api_cost_inr: number;
    storage_bytes: number;
    storage_cost_usd: number;
    storage_cost_inr: number;
    total_cost_usd: number;
    total_cost_inr: number;
  };
  companies: CompanyBillingRow[];
}

type ApiUsageTotalsRow = {
  api_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  api_cost_usd: number;
  live_calls: number;
  estimate_calls: number;
  live_cost_usd: number;
  estimate_cost_usd: number;
};

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
    backfill_calibration: number;
  }> {
    const { data } = await this.supabase
      .from('system_settings')
      .select('key, value')
      .in('key', [
        'billing_gemini_input_usd_per_1m',
        'billing_gemini_output_usd_per_1m',
        'billing_storage_usd_per_gb_month',
        'billing_usd_to_inr',
        'billing_backfill_calibration',
      ]);

    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    return {
      gemini_input_usd_per_1m: Number(map.get('billing_gemini_input_usd_per_1m') ?? this.config.get('BILLING_GEMINI_INPUT_USD_PER_1M') ?? 0.3),
      gemini_output_usd_per_1m: Number(map.get('billing_gemini_output_usd_per_1m') ?? this.config.get('BILLING_GEMINI_OUTPUT_USD_PER_1M') ?? 2.5),
      storage_usd_per_gb_month: Number(map.get('billing_storage_usd_per_gb_month') ?? this.config.get('BILLING_STORAGE_USD_PER_GB_MONTH') ?? 0.125),
      usd_to_inr: Number(map.get('billing_usd_to_inr') ?? this.config.get('BILLING_USD_TO_INR') ?? 83),
      backfill_calibration: Number(map.get('billing_backfill_calibration') ?? 1),
    };
  }

  private monthBounds(): { from: string; to: string } {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: from.toISOString(), to: now.toISOString() };
  }

  private roundUsd(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private roundInr(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private applyCalibration(
    totals: ApiUsageTotalsRow,
    calibration: number,
    usdToInr: number,
  ): {
    api_cost_usd: number;
    api_cost_inr: number;
    live_api_cost_inr: number;
    estimated_api_cost_inr: number;
  } {
    const live_cost_usd = Number(totals.live_cost_usd ?? 0);
    const estimate_cost_usd = Number(totals.estimate_cost_usd ?? 0) * calibration;
    const api_cost_usd = this.roundUsd(live_cost_usd + estimate_cost_usd);
    return {
      api_cost_usd,
      api_cost_inr: this.roundInr(api_cost_usd * usdToInr),
      live_api_cost_inr: this.roundInr(live_cost_usd * usdToInr),
      estimated_api_cost_inr: this.roundInr(estimate_cost_usd * usdToInr),
    };
  }

  async getBillingOverview(month?: string): Promise<BillingOverview> {
    await this.usageBackfill.ensureBackfill();

    const rates = await this.loadBillingRates();
    const period = this.resolvePeriod(month);
    const metering = await this.loadMeteringMeta(period.from, period.to, rates.backfill_calibration);

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
        live_api_calls: acc.live_api_calls + row.live_api_calls,
        estimated_api_calls: acc.estimated_api_calls + row.estimated_api_calls,
        live_api_cost_inr: acc.live_api_cost_inr + row.live_api_cost_inr,
        estimated_api_cost_inr: acc.estimated_api_cost_inr + row.estimated_api_cost_inr,
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
        live_api_calls: 0,
        estimated_api_calls: 0,
        live_api_cost_inr: 0,
        estimated_api_cost_inr: 0,
        storage_bytes: 0,
        storage_cost_usd: 0,
        storage_cost_inr: 0,
        total_cost_usd: 0,
        total_cost_inr: 0,
      },
    );

    platform_totals.api_cost_usd = this.roundUsd(platform_totals.api_cost_usd);
    platform_totals.api_cost_inr = this.roundInr(platform_totals.api_cost_inr);
    platform_totals.total_cost_usd = this.roundUsd(platform_totals.total_cost_usd);
    platform_totals.total_cost_inr = this.roundInr(platform_totals.total_cost_inr);

    return {
      currency: { usd_to_inr: rates.usd_to_inr },
      rates: {
        gemini_input_usd_per_1m: rates.gemini_input_usd_per_1m,
        gemini_output_usd_per_1m: rates.gemini_output_usd_per_1m,
        storage_usd_per_gb_month: rates.storage_usd_per_gb_month,
        backfill_calibration: rates.backfill_calibration,
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
    calibration: number,
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

    const calibrationNote =
      calibration === 1
        ? 'Historical rows use body-size token estimates. Compare once to Google AI Studio; tune billing_backfill_calibration in system_settings if needed.'
        : `Historical estimate rows are multiplied by ${calibration}× (billing_backfill_calibration). Live metered calls are unchanged.`;

    return {
      disclaimer:
        'Tenant cost estimate for invoicing — not a Google invoice. Live rows use real Gemini token counts; historical rows reconstruct classified emails from your database.',
      metered_since,
      live_api_calls,
      estimated_backfill_calls,
      storage_note: 'Storage = email bodies + subjects + conversation summaries (not full cloud infra bill).',
      calibration_note: calibrationNote,
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

  private async fetchApiUsageTotals(
    companyId: string,
    from: string,
    to: string,
  ): Promise<ApiUsageTotalsRow> {
    const { data, error } = await this.supabase.rpc('company_api_usage_totals', {
      p_company_id: companyId,
      p_from: from,
      p_to: to,
    });

    if (error) {
      this.logger.warn(`company_api_usage_totals RPC failed: ${error.message} — using fallback`);
      return this.fallbackApiUsageTotals(companyId, from, to);
    }

    const row = ((data ?? [])[0] ?? {}) as Partial<ApiUsageTotalsRow>;
    return {
      api_calls: Number(row.api_calls ?? 0),
      prompt_tokens: Number(row.prompt_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      api_cost_usd: Number(row.api_cost_usd ?? 0),
      live_calls: Number(row.live_calls ?? 0),
      estimate_calls: Number(row.estimate_calls ?? 0),
      live_cost_usd: Number(row.live_cost_usd ?? 0),
      estimate_cost_usd: Number(row.estimate_cost_usd ?? 0),
    };
  }

  /** Paginated fallback if RPC is not deployed yet. */
  private async fallbackApiUsageTotals(
    companyId: string,
    from: string,
    to: string,
  ): Promise<ApiUsageTotalsRow> {
    const pageSize = 1000;
    let offset = 0;
    const totals: ApiUsageTotalsRow = {
      api_calls: 0,
      prompt_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      api_cost_usd: 0,
      live_calls: 0,
      estimate_calls: 0,
      live_cost_usd: 0,
      estimate_cost_usd: 0,
    };

    for (;;) {
      const { data, error } = await this.supabase
        .from('api_usage_events')
        .select('prompt_tokens, output_tokens, total_tokens, estimated_cost_usd, operation')
        .eq('company_id', companyId)
        .gte('created_at', from)
        .lt('created_at', to)
        .range(offset, offset + pageSize - 1);

      if (error) {
        this.logger.warn(`fallbackApiUsageTotals: ${error.message}`);
        break;
      }

      const rows = data ?? [];
      for (const row of rows as Array<{
        prompt_tokens: number;
        output_tokens: number;
        total_tokens: number;
        estimated_cost_usd: number;
        operation: string;
      }>) {
        const cost = Number(row.estimated_cost_usd ?? 0);
        totals.api_calls += 1;
        totals.prompt_tokens += row.prompt_tokens ?? 0;
        totals.output_tokens += row.output_tokens ?? 0;
        totals.total_tokens += row.total_tokens ?? 0;
        totals.api_cost_usd += cost;
        if (row.operation === 'backfill_estimate') {
          totals.estimate_calls += 1;
          totals.estimate_cost_usd += cost;
        } else {
          totals.live_calls += 1;
          totals.live_cost_usd += cost;
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    totals.api_cost_usd = this.roundUsd(totals.api_cost_usd);
    totals.live_cost_usd = this.roundUsd(totals.live_cost_usd);
    totals.estimate_cost_usd = this.roundUsd(totals.estimate_cost_usd);
    return totals;
  }

  private async buildCompanyBillingRow(
    companyId: string,
    companyName: string,
    from: string,
    to: string,
    rates: {
      storage_usd_per_gb_month: number;
      usd_to_inr: number;
      backfill_calibration: number;
    },
  ): Promise<CompanyBillingRow> {
    const [apiTotals, storageRes, countsRes] = await Promise.all([
      this.fetchApiUsageTotals(companyId, from, to),
      this.supabase.rpc('company_storage_bytes', { p_company_id: companyId }),
      Promise.all([
        this.supabase.from('email_messages').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
        this.supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
        this.supabase.from('employees').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
      ]),
    ]);

    const costs = this.applyCalibration(apiTotals, rates.backfill_calibration, rates.usd_to_inr);

    let storage_bytes = 0;
    if (storageRes.error) {
      storage_bytes = await this.fallbackStorageBytes(companyId);
    } else {
      storage_bytes = Number(storageRes.data ?? 0);
    }

    const storage_gb = storage_bytes / (1024 ** 3);
    const storage_cost_usd = this.roundUsd(storage_gb * rates.storage_usd_per_gb_month);
    const storage_cost_inr = this.roundInr(storage_cost_usd * rates.usd_to_inr);
    const total_cost_usd = this.roundUsd(costs.api_cost_usd + storage_cost_usd);
    const total_cost_inr = this.roundInr(costs.api_cost_inr + storage_cost_inr);

    return {
      company_id: companyId,
      company_name: companyName,
      api_calls: apiTotals.api_calls,
      prompt_tokens: apiTotals.prompt_tokens,
      output_tokens: apiTotals.output_tokens,
      total_tokens: apiTotals.total_tokens,
      api_cost_usd: costs.api_cost_usd,
      api_cost_inr: costs.api_cost_inr,
      live_api_calls: apiTotals.live_calls,
      estimated_api_calls: apiTotals.estimate_calls,
      live_api_cost_inr: costs.live_api_cost_inr,
      estimated_api_cost_inr: costs.estimated_api_cost_inr,
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
