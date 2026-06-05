import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { AlertsService } from './alerts.service';
import { TelegramService } from './telegram.service';
import { EmailModule } from '../email/email.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [EmailModule, SettingsModule],
  providers: [supabaseProvider, TelegramService, AlertsService],
  exports: [AlertsService, TelegramService],
})
export class AlertsModule {}
