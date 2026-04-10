import { Module, forwardRef } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { ConversationsModule } from '../conversations/conversations.module';
import { EmployeesModule } from '../employees/employees.module';
import { EmailIngestionModule } from '../email-ingestion/email-ingestion.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';
import { SelfTrackingService } from './self-tracking.service';
import { SelfTrackingController } from './self-tracking.controller';
import { HistoricalFetchService } from './historical-fetch.service';

@Module({
  imports: [
    EmployeesModule,
    ConversationsModule,
    forwardRef(() => EmailIngestionModule),
    AuthModule,
    SettingsModule,
    CompanyPolicyModule,
  ],
  controllers: [SelfTrackingController],
  providers: [supabaseProvider, SelfTrackingService, HistoricalFetchService],
  exports: [SelfTrackingService],
})
export class SelfTrackingModule {}
