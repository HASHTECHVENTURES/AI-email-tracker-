import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { supabaseProvider } from '../common/supabase.provider';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';

@Module({
  imports: [CompanyPolicyModule],
  providers: [supabaseProvider, SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
