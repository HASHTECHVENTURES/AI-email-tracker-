import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

export interface CompanyPlatformFlags {
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
}

@Injectable()
export class CompanyPolicyService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async getFlags(companyId: string): Promise<CompanyPlatformFlags> {
    const { data, error } = await this.supabase
      .from('companies')
      .select('admin_ai_enabled, admin_email_crawl_enabled')
      .eq('id', companyId)
      .maybeSingle();

    if (error || !data) {
      return { admin_ai_enabled: true, admin_email_crawl_enabled: true };
    }
    const row = data as {
      admin_ai_enabled?: boolean | null;
      admin_email_crawl_enabled?: boolean | null;
    };
    return {
      admin_ai_enabled: row.admin_ai_enabled !== false,
      admin_email_crawl_enabled: row.admin_email_crawl_enabled !== false,
    };
  }

  async isAiEnabledForCompany(companyId: string): Promise<boolean> {
    const f = await this.getFlags(companyId);
    return f.admin_ai_enabled;
  }

  async isEmailCrawlEnabledForCompany(companyId: string): Promise<boolean> {
    const f = await this.getFlags(companyId);
    return f.admin_email_crawl_enabled;
  }
}
