import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';
import { EmailIngestionModule } from '../email-ingestion/email-ingestion.module';
import { supabaseProvider } from '../common/supabase.provider';
import { SystemController } from './system.controller';
import { SystemDiagnosticsService } from './system-diagnostics.service';

@Module({
  imports: [SettingsModule, CompanyPolicyModule, EmailIngestionModule],
  controllers: [SystemController],
  providers: [supabaseProvider, SystemDiagnosticsService],
})
export class SystemModule {}
