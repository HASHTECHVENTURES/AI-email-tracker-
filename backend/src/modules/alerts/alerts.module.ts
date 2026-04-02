import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { AlertsService } from './alerts.service';
import { TelegramService } from './telegram.service';

@Module({
  providers: [supabaseProvider, TelegramService, AlertsService],
  exports: [AlertsService, TelegramService],
})
export class AlertsModule {}
