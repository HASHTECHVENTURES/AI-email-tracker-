import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { GeminiUsageService } from './gemini-usage.service';
import { CompanyBillingService } from './company-billing.service';
import { UsageBackfillService } from './usage-backfill.service';

@Module({
  providers: [supabaseProvider, GeminiUsageService, CompanyBillingService, UsageBackfillService],
  exports: [GeminiUsageService, CompanyBillingService, UsageBackfillService],
})
export class UsageModule {}
