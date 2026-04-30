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

/** Counts of `public.users` rows per role for one company (portal logins, not org chart). */
export interface PortalLoginRoleCounts {
  ceo: number;
  head: number;
  employee: number;
  platform_admin: number;
}

export interface PlatformCompanyRow {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  /** Total `users` rows for this company (sum of portal_login_roles). */
  user_count: number;
  employee_count: number;
  portal_login_roles: PortalLoginRoleCounts;
}

export interface CompanyDetailUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
  linked_employee_id: string | null;
}

export interface CompanyDetailEmployee {
  id: string;
  name: string;
  email: string;
  mailbox_type: string | null;
  gmail_status: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  tracking_paused: boolean;
  tracking_start_at: string | null;
  last_synced_at: string | null;
  department_name: string | null;
  conversation_count: number;
  message_count: number;
}

export interface CompanyAiUsage {
  ai_classified_messages: number;
  ai_enriched_conversations: number;
  ai_quota_fallback_messages: number;
  executive_reports_generated: number;
  historical_search_runs: number;
  last_executive_report_at: string | null;
  last_historical_search_at: string | null;
}

export interface CompanyDetail {
  id: string;
  name: string;
  created_at: string;
  admin_ai_enabled: boolean;
  admin_email_crawl_enabled: boolean;
  users: CompanyDetailUser[];
  employees: CompanyDetailEmployee[];
  ai_usage: CompanyAiUsage;
  totals: {
    users: number;
    employees: number;
    active_mailboxes: number;
    connected_mailboxes: number;
    conversations: number;
    messages: number;
    departments: number;
  };
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

    const companyIds = rows.map((c) => c.id);
    const emptyRoles = (): PortalLoginRoleCounts => ({
      ceo: 0,
      head: 0,
      employee: 0,
      platform_admin: 0,
    });
    const rolesByCompany = new Map<string, PortalLoginRoleCounts>();
    for (const id of companyIds) {
      rolesByCompany.set(id, emptyRoles());
    }

    if (companyIds.length > 0) {
      const { data: roleRows, error: roleErr } = await this.supabase
        .from('users')
        .select('company_id, role')
        .in('company_id', companyIds);
      if (roleErr) {
        this.logger.error(`listCompanies role aggregation: ${roleErr.message}`);
        throw roleErr;
      }
      for (const u of roleRows ?? []) {
        const cid = (u as { company_id?: string }).company_id;
        if (!cid) continue;
        const bag = rolesByCompany.get(cid);
        if (!bag) continue;
        const role = String((u as { role?: string }).role ?? 'EMPLOYEE');
        if (role === 'CEO') bag.ceo += 1;
        else if (role === 'HEAD') bag.head += 1;
        else if (role === 'PLATFORM_ADMIN') bag.platform_admin += 1;
        else bag.employee += 1;
      }
    }

    const empCountResults = await Promise.all(
      rows.map((c) =>
        this.supabase
          .from('employees')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', c.id)
          .then((r) => ({ id: c.id, count: r.count ?? 0 })),
      ),
    );
    const empCountById = new Map(empCountResults.map((x) => [x.id, x.count]));

    const out: PlatformCompanyRow[] = [];
    for (const c of rows) {
      const roles = rolesByCompany.get(c.id) ?? emptyRoles();
      const uc = roles.ceo + roles.head + roles.employee + roles.platform_admin;
      out.push({
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        admin_ai_enabled: c.admin_ai_enabled !== false,
        admin_email_crawl_enabled: c.admin_email_crawl_enabled !== false,
        user_count: uc,
        employee_count: empCountById.get(c.id) ?? 0,
        portal_login_roles: roles,
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
      portal_login_roles: email
        ? { ceo: 1, head: 0, employee: 0, platform_admin: 0 }
        : { ceo: 0, head: 0, employee: 0, platform_admin: 0 },
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

  async getCompanyDetail(companyId: string): Promise<CompanyDetail> {
    const { data: company, error: cErr } = await this.supabase
      .from('companies')
      .select('id, name, created_at, admin_ai_enabled, admin_email_crawl_enabled')
      .eq('id', companyId)
      .maybeSingle();

    if (cErr || !company) {
      throw new NotFoundException('Company not found');
    }

    const c = company as {
      id: string;
      name: string;
      created_at: string;
      admin_ai_enabled?: boolean;
      admin_email_crawl_enabled?: boolean;
    };

    const [usersRes, empsRes, deptsRes, convoCountRes, msgCountRes] = await Promise.all([
      this.supabase
        .from('users')
        .select('id, email, full_name, role, created_at, linked_employee_id')
        .eq('company_id', companyId)
        .order('role')
        .order('created_at'),
      this.supabase
        .from('employees')
        .select(
          'id, name, email, mailbox_type, gmail_status, is_active, ai_enabled, tracking_paused, tracking_start_at, last_synced_at, department_id',
        )
        .eq('company_id', companyId)
        .order('mailbox_type')
        .order('name'),
      this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', companyId),
      this.supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId),
      this.supabase
        .from('email_messages')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId),
    ]);

    const users = ((usersRes.data ?? []) as CompanyDetailUser[]);
    const deptMap = new Map<string, string>();
    for (const d of (deptsRes.data ?? []) as { id: string; name: string }[]) {
      deptMap.set(d.id, d.name);
    }

    const empRows = (empsRes.data ?? []) as Array<{
      id: string;
      name: string;
      email: string;
      mailbox_type: string | null;
      gmail_status: string | null;
      is_active: boolean;
      ai_enabled: boolean;
      tracking_paused: boolean;
      tracking_start_at: string | null;
      last_synced_at: string | null;
      department_id: string | null;
    }>;

    const convoCounts = new Map<string, number>();
    const msgCounts = new Map<string, number>();
    for (const e of empRows) {
      const [{ count: cc }, { count: mc }] = await Promise.all([
        this.supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('employee_id', e.id),
        this.supabase.from('email_messages').select('*', { count: 'exact', head: true }).eq('employee_id', e.id),
      ]);
      convoCounts.set(e.id, cc ?? 0);
      msgCounts.set(e.id, mc ?? 0);
    }

    const employees: CompanyDetailEmployee[] = empRows.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      mailbox_type: e.mailbox_type,
      gmail_status: e.gmail_status,
      is_active: e.is_active !== false,
      ai_enabled: e.ai_enabled !== false,
      tracking_paused: e.tracking_paused === true,
      tracking_start_at: e.tracking_start_at,
      last_synced_at: e.last_synced_at,
      department_name: e.department_id ? deptMap.get(e.department_id) ?? null : null,
      conversation_count: convoCounts.get(e.id) ?? 0,
      message_count: msgCounts.get(e.id) ?? 0,
    }));

    const [
      aiClassifiedRes,
      aiQuotaFallbackRes,
      aiEnrichedRes,
      execReportsRes,
      histRunsRes,
      lastReportRes,
      lastHistRes,
    ] = await Promise.all([
      this.supabase
        .from('email_messages')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .not('relevance_reason', 'is', null),
      this.supabase
        .from('email_messages')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .ilike('relevance_reason', '%quota exhausted%'),
      this.supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .neq('summary', ''),
      this.supabase
        .from('dashboard_reports')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId),
      this.supabase
        .from('historical_search_runs')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId),
      this.supabase
        .from('dashboard_reports')
        .select('created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase
        .from('historical_search_runs')
        .select('created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const aiUsage: CompanyAiUsage = {
      ai_classified_messages: aiClassifiedRes.count ?? 0,
      ai_enriched_conversations: aiEnrichedRes.count ?? 0,
      ai_quota_fallback_messages: aiQuotaFallbackRes.count ?? 0,
      executive_reports_generated: execReportsRes.count ?? 0,
      historical_search_runs: histRunsRes.count ?? 0,
      last_executive_report_at: (lastReportRes.data as { created_at: string } | null)?.created_at ?? null,
      last_historical_search_at: (lastHistRes.data as { created_at: string } | null)?.created_at ?? null,
    };

    return {
      id: c.id,
      name: c.name,
      created_at: c.created_at,
      admin_ai_enabled: c.admin_ai_enabled !== false,
      admin_email_crawl_enabled: c.admin_email_crawl_enabled !== false,
      users,
      employees,
      ai_usage: aiUsage,
      totals: {
        users: users.length,
        employees: employees.length,
        active_mailboxes: employees.filter((e) => e.is_active).length,
        connected_mailboxes: employees.filter((e) => e.gmail_status === 'CONNECTED').length,
        conversations: convoCountRes.count ?? 0,
        messages: msgCountRes.count ?? 0,
        departments: deptMap.size,
      },
    };
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
