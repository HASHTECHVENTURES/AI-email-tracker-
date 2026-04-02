import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { TelegramService } from '../alerts/telegram.service';

@Module({
  controllers: [DashboardController],
  providers: [supabaseProvider, DashboardService, TelegramService],
  exports: [DashboardService],
})
export class DashboardModule {}
