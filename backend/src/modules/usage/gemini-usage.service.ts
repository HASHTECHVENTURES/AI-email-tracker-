import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

export type GeminiUsageContext = {
  companyId: string;
  employeeId?: string | null;
  operation: 'ingest_relevance' | 'historical_relevance' | 'enrichment' | 'quota_probe';
  model: string;
};

type UsageMetadataLike = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

@Injectable()
export class GeminiUsageService {
  private readonly logger = new Logger(GeminiUsageService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  private inputUsdPer1M(): number {
    return Number(this.config.get('BILLING_GEMINI_INPUT_USD_PER_1M') ?? 0.3);
  }

  private outputUsdPer1M(): number {
    return Number(this.config.get('BILLING_GEMINI_OUTPUT_USD_PER_1M') ?? 2.5);
  }

  estimateCostUsd(promptTokens: number, outputTokens: number): number {
    const inCost = (promptTokens / 1_000_000) * this.inputUsdPer1M();
    const outCost = (outputTokens / 1_000_000) * this.outputUsdPer1M();
    return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
  }

  readUsageMetadata(response: { usageMetadata?: UsageMetadataLike }): {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
  } {
    const meta = response.usageMetadata;
    const promptTokens = Math.max(0, meta?.promptTokenCount ?? 0);
    const outputTokens = Math.max(0, meta?.candidatesTokenCount ?? 0);
    const totalTokens = Math.max(promptTokens + outputTokens, meta?.totalTokenCount ?? 0);
    return { promptTokens, outputTokens, totalTokens };
  }

  async recordFromResponse(
    response: { usageMetadata?: UsageMetadataLike },
    ctx: GeminiUsageContext,
  ): Promise<void> {
    const { promptTokens, outputTokens, totalTokens } = this.readUsageMetadata(response);
    if (totalTokens === 0 && promptTokens === 0 && outputTokens === 0) {
      await this.record({
        ...ctx,
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      });
      return;
    }
    await this.record({
      ...ctx,
      promptTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd: this.estimateCostUsd(promptTokens, outputTokens),
    });
  }

  private async record(payload: GeminiUsageContext & {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }): Promise<void> {
    const { error } = await this.supabase.from('api_usage_events').insert({
      company_id: payload.companyId,
      employee_id: payload.employeeId ?? null,
      operation: payload.operation,
      model: payload.model,
      prompt_tokens: payload.promptTokens,
      output_tokens: payload.outputTokens,
      total_tokens: payload.totalTokens,
      estimated_cost_usd: payload.estimatedCostUsd,
    });
    if (error) {
      this.logger.warn(`api_usage_events insert failed: ${error.message}`);
    }
  }
}
