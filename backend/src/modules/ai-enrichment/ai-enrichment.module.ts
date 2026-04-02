import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { AiEnrichmentService } from './ai-enrichment.service';

@Module({
  providers: [supabaseProvider, AiEnrichmentService],
  exports: [AiEnrichmentService],
})
export class AiEnrichmentModule {}
