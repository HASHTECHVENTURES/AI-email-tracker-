import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

const BACKFILL_FLAG = 'billing_backfill_v1_completed';
const AI_ACTION_PREFIX = /^\[(NEED_REPLY|CC|BCC|CALENDAR|LOW|SKIP)\]/;

/** Token estimate aligned with relevance prompt truncation (300-char target body + overhead). */
export function estimateRelevanceBillingTokens(subject: string | null, body: string | null): {
  promptTokens: number;
  outputTokens: number;
} {
  const bodyChars = Math.min(Buffer.byteLength(body ?? '', 'utf8'), 300);
  const subjectChars = Math.min(Buffer.byteLength(subject ?? '', 'utf8'), 200);
  const promptTokens = Math.min(
    3200,
    Math.max(520, 620 + Math.ceil(bodyChars / 4) + 25 + Math.ceil(subjectChars / 4)),
  );
  return { promptTokens, outputTokens: 28 };
}

/** Ensures historical AI-classified emails have estimated rows in api_usage_events (once). */
@Injectable()
export class UsageBackfillService {
  private readonly logger = new Logger(UsageBackfillService.name);
  private runPromise: Promise<void> | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** Idempotent — safe to call on every billing request. */
  async ensureBackfill(): Promise<void> {
    if (!this.runPromise) {
      this.runPromise = this.runOnce().finally(() => {
        this.runPromise = null;
      });
    }
    await this.runPromise;
  }

  private async markComplete(): Promise<void> {
    await this.supabase.from('system_settings').upsert({
      key: BACKFILL_FLAG,
      value: 'true',
      updated_at: new Date().toISOString(),
    });
  }

  private async runOnce(): Promise<void> {
    const { data: flag } = await this.supabase
      .from('system_settings')
      .select('value')
      .eq('key', BACKFILL_FLAG)
      .maybeSingle();

    if ((flag as { value?: string } | null)?.value === 'true') {
      return;
    }

    const { count: existingBackfill } = await this.supabase
      .from('api_usage_events')
      .select('*', { count: 'exact', head: true })
      .eq('operation', 'backfill_estimate');

    if ((existingBackfill ?? 0) > 0) {
      await this.markComplete();
      return;
    }

    const { data: rates } = await this.supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['billing_gemini_input_usd_per_1m', 'billing_gemini_output_usd_per_1m']);

    const map = new Map((rates ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    const inputRate = Number(map.get('billing_gemini_input_usd_per_1m') ?? 0.3);
    const outputRate = Number(map.get('billing_gemini_output_usd_per_1m') ?? 2.5);

    const pageSize = 500;
    let offset = 0;
    let inserted = 0;

    for (;;) {
      const { data: batch, error } = await this.supabase
        .from('email_messages')
        .select('company_id, employee_id, ingested_at, relevance_reason, subject, body_text')
        .not('relevance_reason', 'is', null)
        .order('ingested_at', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        this.logger.warn(`usage backfill batch failed: ${error.message}`);
        break;
      }

      const rows = ((batch ?? []) as Array<{
        company_id: string;
        employee_id: string | null;
        ingested_at: string;
        relevance_reason: string | null;
        subject: string | null;
        body_text: string | null;
      }>).filter((r) => r.company_id && AI_ACTION_PREFIX.test(r.relevance_reason ?? ''));

      if (rows.length === 0 && (batch ?? []).length < pageSize) break;

      const payload = rows.map((r) => {
        const { promptTokens, outputTokens } = estimateRelevanceBillingTokens(r.subject, r.body_text);
        const costEst =
          Math.round(
            ((promptTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate) * 1_000_000,
          ) / 1_000_000;
        return {
          company_id: r.company_id,
          employee_id: r.employee_id,
          operation: 'backfill_estimate',
          model: 'gemini-2.5-flash',
          prompt_tokens: promptTokens,
          output_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
          estimated_cost_usd: costEst,
          created_at: r.ingested_at,
        };
      });

      if (payload.length > 0) {
        const { error: insErr } = await this.supabase.from('api_usage_events').insert(payload);
        if (insErr) {
          this.logger.warn(`usage backfill insert failed: ${insErr.message}`);
          break;
        }
        inserted += payload.length;
      }

      if ((batch ?? []).length < pageSize) break;
      offset += pageSize;
    }

    await this.markComplete();

    if (inserted > 0) {
      this.logger.log(`Usage backfill: inserted ${inserted} estimated api_usage_events rows`);
    }
  }
}
