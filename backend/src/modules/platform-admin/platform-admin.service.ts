import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { isPlatformAdminEmail } from './platform-admin.guard';

export interface PlatformCompanyRow {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  user_count: number;
  employee_count: number;
}

export interface PlatformStats {
  companies_registered: number;
  total_users: number;
  total_employees: number;
  total_conversations: number;
  companies_with_ai_off: number;
  companies_with_email_crawl_off: number;
}

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async getStats(): Promise<PlatformStats> {
    const [companiesRes, usersRes, empsRes, convosRes, aiOffRes, crawlOffRes] = await Promise.all([
      this.supabase.from('companies').select('*', { count: 'exact', head: true }),
      this.supabase.from('users').select('*', { count: 'exact', head: true }),
      this.supabase.from('employees').select('*', { count: 'exact', head: true }),
      this.supabase.from('conversations').select('*', { count: 'exact', head: true }),
      this.supabase
        .from('companies')
        .select('id', { count: 'exact', head: true })
        .eq('admin_ai_enabled', false),
      this.supabase
        .from('companies')
        .select('id', { count: 'exact', head: true })
        .eq('admin_email_crawl_enabled', false),
    ]);

    return {
      companies_registered: companiesRes.count ?? 0,
      total_users: usersRes.count ?? 0,
      total_employees: empsRes.count ?? 0,
      total_conversations: convosRes.count ?? 0,
      companies_with_ai_off: aiOffRes.count ?? 0,
      companies_with_email_crawl_off: crawlOffRes.count ?? 0,
    };
  }

  async listCompanies(): Promise<PlatformCompanyRow[]> {
    const { data: companies, error } = await this.supabase
      .from('companies')
      .select('id, name, created_at, admin_ai_enabled, admin_email_crawl_enabled')
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`listCompanies: ${error.message}`);
      throw error;
    }

    const rows = (companies ?? []) as Array<{
      id: string;
      name: string;
      created_at: string;
      admin_ai_enabled?: boolean;
      admin_email_crawl_enabled?: boolean;
    }>;

    const out: PlatformCompanyRow[] = [];
    for (const c of rows) {
      const [{ count: uc }, { count: ec }] = await Promise.all([
        this.supabase
          .from('users')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', c.id),
        this.supabase
          .from('employees')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', c.id),
      ]);
      out.push({
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        admin_ai_enabled: c.admin_ai_enabled !== false,
        admin_email_crawl_enabled: c.admin_email_crawl_enabled !== false,
        user_count: uc ?? 0,
        employee_count: ec ?? 0,
      });
    }
    return out;
  }

  async createCompany(dto: {
    name: string;
    ceoEmail?: string;
    ceoPassword?: string;
  }): Promise<PlatformCompanyRow> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Company name is required');
    }

    const { data: company, error: cErr } = await this.supabase
      .from('companies')
      .insert({ name })
      .select('id, name, created_at, admin_ai_enabled, admin_email_crawl_enabled')
      .single();

    if (cErr || !company) {
      throw new BadRequestException(cErr?.message ?? 'Could not create company');
    }

    const row = company as {
      id: string;
      name: string;
      created_at: string;
      admin_ai_enabled?: boolean;
      admin_email_crawl_enabled?: boolean;
    };

    const email = dto.ceoEmail?.trim().toLowerCase();
    const password = dto.ceoPassword?.trim();

    if (email && password) {
      if (password.length < 8) {
        await this.supabase.from('companies').delete().eq('id', row.id);
        throw new BadRequestException('CEO password must be at least 8 characters');
      }
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        await this.supabase.from('companies').delete().eq('id', row.id);
        throw new BadRequestException('SUPABASE_SERVICE_ROLE_KEY is required to create CEO login');
      }

      const { data: authData, error: authErr } = await this.supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: email.split('@')[0] },
      });

      if (authErr || !authData?.user?.id) {
        await this.supabase.from('companies').delete().eq('id', row.id);
        const msg = authErr?.message ?? 'Could not create CEO auth user';
        if (/already been registered|already exists|duplicate/i.test(msg)) {
          throw new BadRequestException('That email already has an account.');
        }
        throw new BadRequestException(msg);
      }

      const { error: pErr } = await this.supabase.from('users').insert({
        id: authData.user.id,
        email,
        full_name: email.split('@')[0],
        company_id: row.id,
        role: 'CEO',
      });

      if (pErr) {
        await this.supabase.auth.admin.deleteUser(authData.user.id);
        await this.supabase.from('companies').delete().eq('id', row.id);
        throw new BadRequestException(pErr.message);
      }
    }

    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      admin_ai_enabled: row.admin_ai_enabled !== false,
      admin_email_crawl_enabled: row.admin_email_crawl_enabled !== false,
      user_count: email ? 1 : 0,
      employee_count: 0,
    };
  }

  async updateCompanyFlags(
    companyId: string,
    patch: { admin_ai_enabled?: boolean; admin_email_crawl_enabled?: boolean },
  ): Promise<void> {
    const updates: Record<string, boolean> = {};
    if (typeof patch.admin_ai_enabled === 'boolean') {
      updates.admin_ai_enabled = patch.admin_ai_enabled;
    }
    if (typeof patch.admin_email_crawl_enabled === 'boolean') {
      updates.admin_email_crawl_enabled = patch.admin_email_crawl_enabled;
    }
    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Provide admin_ai_enabled and/or admin_email_crawl_enabled');
    }

    const { data, error } = await this.supabase
      .from('companies')
      .update(updates)
      .eq('id', companyId)
      .select('id');

    if (error) {
      throw new BadRequestException(error.message);
    }
    if (!data?.length) {
      throw new NotFoundException('Company not found');
    }
  }

  async deleteCompany(companyId: string): Promise<void> {
    const { data: userRows, error: uErr } = await this.supabase
      .from('users')
      .select('id, email')
      .eq('company_id', companyId);

    if (uErr) {
      throw new BadRequestException(uErr.message);
    }

    const rows = (userRows ?? []) as { id: string; email: string }[];

    const { error: delErr } = await this.supabase.from('companies').delete().eq('id', companyId);
    if (delErr) {
      throw new BadRequestException(delErr.message);
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      this.logger.warn('deleteCompany: SUPABASE_SERVICE_ROLE_KEY missing — auth users may be orphaned');
      return;
    }

    for (const row of rows) {
      if (isPlatformAdminEmail(row.email)) {
        this.logger.log(
          `deleteCompany: kept Supabase auth user ${row.id} (platform operator email)`,
        );
        continue;
      }
      const { error: aErr } = await this.supabase.auth.admin.deleteUser(row.id);
      if (aErr) {
        this.logger.warn(`deleteCompany: could not delete auth user ${row.id}: ${aErr.message}`);
      }
    }
  }
}
