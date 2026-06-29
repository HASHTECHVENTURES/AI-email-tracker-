import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { GeminiUsageService } from './gemini-usage.service';
import { CompanyBillingService } from './company-billing.service';

@Module({
  providers: [supabaseProvider, GeminiUsageService, CompanyBillingService],
  exports: [GeminiUsageService, CompanyBillingService],
})
export class UsageModule {}
