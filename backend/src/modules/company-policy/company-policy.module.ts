import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase.provider';
import { CompanyPolicyService } from './company-policy.service';

@Module({
  providers: [supabaseProvider, CompanyPolicyService],
  exports: [CompanyPolicyService],
})
export class CompanyPolicyModule {}
