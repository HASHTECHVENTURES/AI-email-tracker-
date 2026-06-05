import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { EmailService } from './email.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  providers: [supabaseProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
