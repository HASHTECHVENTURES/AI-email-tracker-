import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmployeesModule } from '../employees/employees.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { SettingsModule } from '../settings/settings.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { supabaseProvider } from '../common/supabase.provider';
import { GmailService } from './gmail.service';
import { EmailIngestionService } from './email-ingestion.service';
import { EmailIngestionController } from './email-ingestion.controller';
import { IngestionCronService } from './ingestion-cron.service';

@Module({
  imports: [AuthModule, EmployeesModule, ConversationsModule, SettingsModule, DashboardModule],
  controllers: [EmailIngestionController],
  providers: [supabaseProvider, GmailService, EmailIngestionService, IngestionCronService],
  exports: [EmailIngestionService],
})
export class EmailIngestionModule {}
