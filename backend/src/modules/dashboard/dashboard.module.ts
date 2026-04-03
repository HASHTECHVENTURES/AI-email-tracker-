import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { TelegramService } from '../alerts/telegram.service';
import { EmailModule } from '../email/email.module';
import { EmployeesModule } from '../employees/employees.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [EmailModule, EmployeesModule, SettingsModule],
  controllers: [DashboardController],
  providers: [supabaseProvider, DashboardService, TelegramService],
  exports: [DashboardService],
})
export class DashboardModule {}
