import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmployeesModule } from '../employees/employees.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SettingsModule } from '../settings/settings.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';
import { AiEnrichmentModule } from '../ai-enrichment/ai-enrichment.module';
import { supabaseProvider } from '../common/supabase.provider';
import { GmailService } from './gmail.service';
import { EmailIngestionService } from './email-ingestion.service';
import { EmailIngestionController } from './email-ingestion.controller';
import { IngestionCronService } from './ingestion-cron.service';

@Module({
  imports: [
    AuthModule,
    EmployeesModule,
    ConversationsModule,
    SettingsModule,
    forwardRef(() => DashboardModule),
    CompanyPolicyModule,
    AiEnrichmentModule,
  ],
  controllers: [EmailIngestionController],
  providers: [supabaseProvider, GmailService, EmailIngestionService, IngestionCronService],
  exports: [EmailIngestionService, GmailService],
})
export class EmailIngestionModule {}
