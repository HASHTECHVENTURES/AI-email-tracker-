import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { FollowupModule } from '../followup/followup.module';
import { AiEnrichmentModule } from '../ai-enrichment/ai-enrichment.module';
import { AlertsModule } from '../alerts/alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { supabaseProvider } from '../common/supabase.provider';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';

@Module({
  imports: [FollowupModule, EmployeesModule, AiEnrichmentModule, AlertsModule, SettingsModule],
  controllers: [ConversationsController],
  providers: [supabaseProvider, ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
