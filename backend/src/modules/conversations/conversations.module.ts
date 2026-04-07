import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { FollowupModule } from '../followup/followup.module';
import { AiEnrichmentModule } from '../ai-enrichment/ai-enrichment.module';
import { AlertsModule } from '../alerts/alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailModule } from '../email/email.module';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';
import { supabaseProvider } from '../common/supabase.provider';
import { AuditLogService } from '../common/audit-log.service';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';

@Module({
  imports: [
    FollowupModule,
    EmployeesModule,
    AiEnrichmentModule,
    AlertsModule,
    SettingsModule,
    EmailModule,
    CompanyPolicyModule,
  ],
  controllers: [ConversationsController],
  providers: [supabaseProvider, AuditLogService, ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
