import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { TelegramService } from '../alerts/telegram.service';
import { EmailModule } from '../email/email.module';
import { EmployeesModule } from '../employees/employees.module';
import { SettingsModule } from '../settings/settings.module';
import { CompanyPolicyModule } from '../company-policy/company-policy.module';
import { SelfTrackingModule } from '../self-tracking/self-tracking.module';

@Module({
  imports: [EmailModule, EmployeesModule, SettingsModule, CompanyPolicyModule, SelfTrackingModule],
  controllers: [DashboardController],
  providers: [supabaseProvider, DashboardService, TelegramService],
  exports: [DashboardService],
})
export class DashboardModule {}
