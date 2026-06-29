import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { UsageModule } from '../usage/usage.module';
import { AiEnrichmentService } from './ai-enrichment.service';

@Module({
  imports: [UsageModule],
  providers: [supabaseProvider, AiEnrichmentService],
  exports: [AiEnrichmentService],
})
export class AiEnrichmentModule {}
