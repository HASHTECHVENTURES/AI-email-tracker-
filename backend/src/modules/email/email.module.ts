import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { EmailService } from './email.service';

@Module({
  providers: [supabaseProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
