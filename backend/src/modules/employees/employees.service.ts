import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import type { AuthedRequestUser } from '../../types/express';
import { Employee } from '../common/types';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { RequestContext } from '../common/request-context';

interface EmployeeDbRow {
  id: string;
  name: string;
  email: string;
  company_id: string;
  department_id: string | null;
  created_by: string | null;
  created_at: string;
  is_active?: boolean;
  ai_enabled?: boolean;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
  sla_hours_default?: number | null;
  exclude_patterns?: string[] | null;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  /** `SELF` = CEO-added tracking row; `TEAM` / null = org directory mailboxes */
  mailbox_type?: string | null;
}

/** Org directory row returned to API clients */
export interface OrgEmployeeDto {
  id: string;
  name: string;
  email: string;
  department_id: string | null;
  department_name: string;
  created_at: string;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  /** True when Supabase Auth + app profile were created for Employee portal login */
  login_created?: boolean;
  /** True when a `users` row links this employee (Employee portal) */
  has_portal_login?: boolean;
  /** When true, Gmail fetch / ingestion skips this mailbox (per-employee pause). */
  tracking_paused?: boolean;
  /** When false, Inbox AI + thread enrichment skip this mailbox (per-employee AI pause). */
  ai_enabled?: boolean;
  /** `SELF` = CEO self-tracking add; `TEAM` / null = team / manager mailboxes */
  mailbox_type?: 'SELF' | 'TEAM' | null;
  /**
   * CEO My Email only: true when this `employees` row is the department manager’s inbox
   * (matches a `users` row with role HEAD — by `linked_employee_id` or work email).
   */
  is_manager_mailbox?: boolean;
}

export interface EmployeeMessageDto {
  provider_message_id: string;
  subject: string;
  from_email: string;
  sent_at: string;
}

export interface MailArchiveItem {
  provider_message_id: string;
  provider_thread_id: string;
  subject: string;
  from_email: string;
  direction: string;
  sent_at: string;
  employee_id: string;
  employee_name: string;
  body_preview: string;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** PostgREST / Postgres when `employees.mailbox_type` migration (013) was not applied */
  private isMissingMailboxTypeColumn(err: unknown): boolean {
    const m = String((err as Error)?.message ?? err ?? '');
    const c = String((err as { code?: string })?.code ?? '');
    return (
      c === '42703' ||
      m.includes('mailbox_type') ||
      (m.includes('column') && m.includes('does not exist'))
    );
  }

  /**
   * Creates org employee + (when password set) Supabase Auth user and `public.users` row so they can log in
   * at the Employee portal with the email + password the manager chose.
   */
  async createOrgEmployee(
    ctx: RequestContext,
    userId: string,
    dto: { name: string; email: string; departmentId: string; password: string },
  ): Promise<OrgEmployeeDto> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot create records');
    }

    const name = dto.name.trim();
    const email = dto.email.trim().toLowerCase();
    if (!name || !email || !dto.departmentId) {
      throw new BadRequestException('name, email, and departmentId are required');
    }
    const password = dto.password?.trim() ?? '';
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters (manager sets login for this team member)');
    }

    const dept = await this.assertDepartmentInCompany(ctx.companyId, dto.departmentId);

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId) {
        throw new ForbiddenException('Department head must have a department assigned');
      }
      if (dto.departmentId !== ctx.departmentId) {
        throw new ForbiddenException('You can only add employees to your own department');
      }
    }

    const startIso = new Date().toISOString();

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      throw new BadRequestException(
        'Server must use SUPABASE_SERVICE_ROLE_KEY to create employee logins. Set it in the API environment.',
      );
    }

    const { data: authData, error: authErr } = await this.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });

    if (authErr || !authData?.user?.id) {
      const msg = authErr?.message ?? 'Could not create login';
      if (/already been registered|already exists|duplicate/i.test(msg)) {
        throw new BadRequestException(
          'This email already has an account. Use another email or sign in with the existing account.',
        );
      }
      this.logger.error(`createOrgEmployee auth: ${msg}`);
      throw new BadRequestException(msg);
    }

    const newAuthId = authData.user.id;

    const { data, error } = await this.supabase
      .from('employees')
      .insert({
        name,
        email,
        company_id: ctx.companyId,
        department_id: dto.departmentId,
        created_by: userId,
        is_active: true,
        ai_enabled: true,
        tracking_paused: false,
        tracking_start_at: startIso,
      })
      .select('id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at')
      .single();

    if (error) {
      await this.safeDeleteAuthUser(newAuthId);
      if (error.code === '23505') {
        throw new BadRequestException('An employee with this email already exists in your company');
      }
      this.logger.error('Failed to create employee', error.message);
      throw error;
    }

    const row = data as EmployeeDbRow;

    const { error: profileErr } = await this.supabase.from('users').insert({
      id: newAuthId,
      email,
      full_name: name,
      company_id: ctx.companyId,
      role: 'EMPLOYEE',
      department_id: dto.departmentId,
      linked_employee_id: row.id,
    });

    if (profileErr) {
      await this.supabase.from('employees').delete().eq('id', row.id);
      await this.safeDeleteAuthUser(newAuthId);
      this.logger.error(`createOrgEmployee users profile: ${profileErr.message}`);
      throw new BadRequestException('Could not create app profile for this login. Try again or contact support.');
    }

    await this.ensureMailSyncState(row.id, startIso);

    const dtoOut = this.toOrgDto(row, dept.name);
    dtoOut.login_created = true;
    return dtoOut;
  }

  /**
   * Department manager self-mailbox helper for `/my-mail`:
   * ensure there is a tracked mailbox row that matches the manager's login email.
   */
  async ensureMyMailbox(ctx: RequestContext, user: AuthedRequestUser): Promise<OrgEmployeeDto> {
    if (ctx.role !== 'HEAD') {
      throw new ForbiddenException('Only managers can create or access a personal manager mailbox');
    }
    if (!ctx.departmentId) {
      throw new ForbiddenException('Manager must have a department assigned');
    }

    const email = user.email.trim().toLowerCase();
    const name =
      user.fullName?.trim() ||
      email.split('@')[0] ||
      'Manager';

    const existing = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled, mailbox_type',
      )
      .eq('company_id', ctx.companyId)
      .eq('email', email)
      .maybeSingle();

    if (existing.error) {
      this.logger.error(`ensureMyMailbox lookup: ${existing.error.message}`);
      throw new InternalServerErrorException(existing.error.message);
    }

    if (existing.data) {
      const row = existing.data as EmployeeDbRow;
      if (row.department_id !== ctx.departmentId) {
        throw new ForbiddenException('Your login email is already used by another department mailbox');
      }
      const deptName = await this.getDepartmentName(ctx.companyId, row.department_id);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        department_id: row.department_id,
        department_name: deptName,
        created_at: row.created_at,
        gmail_connected: (row.gmail_status ?? 'EXPIRED') === 'CONNECTED',
        gmail_status: (row.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
        last_synced_at: row.last_synced_at ?? null,
        sla_hours_default: row.sla_hours_default ?? null,
        tracking_start_at: row.tracking_start_at ?? null,
        tracking_paused: row.tracking_paused === true,
        ai_enabled: row.ai_enabled !== false,
        mailbox_type: (row.mailbox_type as 'TEAM' | null | undefined) ?? null,
      };
    }

    const startIso = new Date().toISOString();
    const insertResult = await this.supabase
      .from('employees')
      .insert({
        name,
        email,
        company_id: ctx.companyId,
        department_id: ctx.departmentId,
        created_by: user.id,
        is_active: true,
        ai_enabled: true,
        tracking_paused: false,
        tracking_start_at: startIso,
        mailbox_type: 'TEAM',
      })
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled, mailbox_type',
      )
      .single();

    if (insertResult.error && this.isMissingMailboxTypeColumn(insertResult.error)) {
      const fallback = await this.supabase
        .from('employees')
        .insert({
          name,
          email,
          company_id: ctx.companyId,
          department_id: ctx.departmentId,
          created_by: user.id,
          is_active: true,
          ai_enabled: true,
          tracking_paused: false,
          tracking_start_at: startIso,
        })
        .select(
          'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled',
        )
        .single();
      if (fallback.error) {
        if (fallback.error.code === '23505') {
          throw new BadRequestException('A mailbox with your email already exists in this company');
        }
        this.logger.error(`ensureMyMailbox fallback insert: ${fallback.error.message}`);
        throw new InternalServerErrorException(fallback.error.message);
      }
      await this.ensureMailSyncState((fallback.data as EmployeeDbRow).id, startIso);
      const row = fallback.data as EmployeeDbRow;
      const deptName = await this.getDepartmentName(ctx.companyId, row.department_id);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        department_id: row.department_id,
        department_name: deptName,
        created_at: row.created_at,
        gmail_connected: (row.gmail_status ?? 'EXPIRED') === 'CONNECTED',
        gmail_status: (row.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
        last_synced_at: row.last_synced_at ?? null,
        sla_hours_default: row.sla_hours_default ?? null,
        tracking_start_at: row.tracking_start_at ?? null,
        tracking_paused: row.tracking_paused === true,
        ai_enabled: row.ai_enabled !== false,
        mailbox_type: null,
      };
    }

    if (insertResult.error) {
      if (insertResult.error.code === '23505') {
        throw new BadRequestException('A mailbox with your email already exists in this company');
      }
      this.logger.error(`ensureMyMailbox insert: ${insertResult.error.message}`);
      throw new InternalServerErrorException(insertResult.error.message);
    }

    const row = insertResult.data as EmployeeDbRow;
    await this.ensureMailSyncState(row.id, startIso);
    const deptName = await this.getDepartmentName(ctx.companyId, row.department_id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      department_id: row.department_id,
      department_name: deptName,
      created_at: row.created_at,
      gmail_connected: (row.gmail_status ?? 'EXPIRED') === 'CONNECTED',
      gmail_status: (row.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      last_synced_at: row.last_synced_at ?? null,
      sla_hours_default: row.sla_hours_default ?? null,
      tracking_start_at: row.tracking_start_at ?? null,
      tracking_paused: row.tracking_paused === true,
      ai_enabled: row.ai_enabled !== false,
      mailbox_type: (row.mailbox_type as 'TEAM' | null | undefined) ?? null,
    };
  }

  private async safeDeleteAuthUser(userId: string): Promise<void> {
    const { error } = await this.supabase.auth.admin.deleteUser(userId);
    if (error) {
      this.logger.warn(`safeDeleteAuthUser ${userId}: ${error.message}`);
    }
  }

  /**
   * Manager/CEO: set initial Employee portal password or change an existing one.
   * If no `users` row linked to this employee yet, creates Auth user + profile (same as add-employee login).
   */
  async setOrProvisionEmployeePortalPassword(
    ctx: RequestContext,
    employeeId: string,
    newPassword: string,
  ): Promise<{ ok: true; action: 'password_updated' | 'login_created' }> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot change other users passwords');
    }

    const password = newPassword.trim();
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      throw new BadRequestException(
        'Server must use SUPABASE_SERVICE_ROLE_KEY for password operations. Set it in the API environment.',
      );
    }

    const { data: emp, error: empErr } = await this.supabase
      .from('employees')
      .select('id, name, email, company_id, department_id')
      .eq('id', employeeId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();

    if (empErr) {
      this.logger.error(`setOrProvisionEmployeePortalPassword load: ${empErr.message}`);
      throw empErr;
    }
    if (!emp) {
      throw new NotFoundException('Employee not found');
    }

    const row = emp as { id: string; name: string; email: string; company_id: string; department_id: string };

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || row.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only manage employees in your department');
      }
    }

    const email = row.email.trim().toLowerCase();
    const fullName = row.name.trim();

    const { data: existingProfile } = await this.supabase
      .from('users')
      .select('id')
      .eq('linked_employee_id', employeeId)
      .maybeSingle();

    if (existingProfile) {
      const authId = (existingProfile as { id: string }).id;
      const { error: updErr } = await this.supabase.auth.admin.updateUserById(authId, { password });
      if (updErr) {
        this.logger.error(`employee portal password update: ${updErr.message}`);
        throw new BadRequestException(updErr.message || 'Could not update password');
      }
      return { ok: true, action: 'password_updated' };
    }

    const { data: authData, error: authErr } = await this.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (authErr || !authData?.user?.id) {
      const msg = authErr?.message ?? 'Could not create login';
      if (/already been registered|already exists|duplicate/i.test(msg)) {
        throw new BadRequestException(
          'This email already has an auth account. If it is not linked to this employee, contact your administrator.',
        );
      }
      this.logger.error(`setOrProvisionEmployeePortalPassword createUser: ${msg}`);
      throw new BadRequestException(msg);
    }

    const newAuthId = authData.user.id;

    const { error: profileErr } = await this.supabase.from('users').insert({
      id: newAuthId,
      email,
      full_name: fullName,
      company_id: ctx.companyId,
      role: 'EMPLOYEE',
      department_id: row.department_id,
      linked_employee_id: employeeId,
    });

    if (profileErr) {
      await this.safeDeleteAuthUser(newAuthId);
      this.logger.error(`setOrProvisionEmployeePortalPassword users insert: ${profileErr.message}`);
      throw new BadRequestException('Could not create app profile for this login.');
    }

    return { ok: true, action: 'login_created' };
  }

  async employeeExists(employeeId: string): Promise<boolean> {
    const { data } = await this.supabase.from('employees').select('id').eq('id', employeeId).maybeSingle();
    return data !== null;
  }

  async assertCanInitiateGmailOAuth(user: AuthedRequestUser, employeeId: string): Promise<void> {
    if (user.role === 'EMPLOYEE') {
      if (!user.linkedEmployeeId || user.linkedEmployeeId !== employeeId) {
        throw new ForbiddenException('You can only connect Gmail for your own mailbox');
      }
    }
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, company_id, department_id')
      .eq('id', employeeId)
      .maybeSingle();
    if (error || !data) {
      throw new BadRequestException('Employee not found');
    }
    const row = data as { company_id: string; department_id: string };
    if (row.company_id !== user.companyId) {
      throw new ForbiddenException('Employee is not in your company');
    }
    if (user.role === 'HEAD') {
      if (!user.departmentId || row.department_id !== user.departmentId) {
        throw new ForbiddenException('You can only connect Gmail for employees in your department');
      }
    }
  }

  /** Call after Gmail OAuth succeeds so ingestion has a cursor. */
  async ensureMailSyncAfterOAuth(employeeId: string): Promise<void> {
    await this.ensureMailSyncState(employeeId, new Date().toISOString());
    await this.supabase
      .from('employees')
      .update({ gmail_status: 'CONNECTED' })
      .eq('id', employeeId);
  }

  private async ensureMailSyncState(employeeId: string, startIso: string): Promise<void> {
    const { error } = await this.supabase.from('mail_sync_state').upsert(
      {
        employee_id: employeeId,
        start_date: startIso,
        last_processed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'employee_id' },
    );
    if (error) {
      this.logger.warn(`Could not seed mail_sync_state for ${employeeId}: ${error.message}`);
    }
  }

  async listOrgEmployees(ctx: RequestContext): Promise<OrgEmployeeDto[]> {
    if (ctx.role === 'EMPLOYEE') {
      return [];
    }

    let query = this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled, mailbox_type',
      )
      .eq('company_id', ctx.companyId)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM')
      .order('name', { ascending: true });

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId) {
        return [];
      }
      query = query.eq('department_id', ctx.departmentId);
    }

    const listResult = await query;
    let data = listResult.data as EmployeeDbRow[] | null;
    let error = listResult.error;
    if (error && this.isMissingMailboxTypeColumn(error)) {
      this.logger.warn('listOrgEmployees: mailbox_type unavailable, listing without column (apply migration 013)');
      let q2 = this.supabase
        .from('employees')
        .select(
          'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled',
        )
        .eq('company_id', ctx.companyId)
        .order('name', { ascending: true });
      if (ctx.role === 'HEAD') {
        if (!ctx.departmentId) {
          return [];
        }
        q2 = q2.eq('department_id', ctx.departmentId);
      }
      const r2 = await q2;
      if (r2.error) {
        this.logger.error('Failed to list employees (legacy)', r2.error.message);
        throw new InternalServerErrorException(r2.error.message);
      }
      data = (r2.data ?? []) as EmployeeDbRow[] | null;
      error = null;
    } else if (error) {
      this.logger.error('Failed to list employees', error.message);
      throw new InternalServerErrorException(error.message);
    }

    const rows = (data ?? []) as EmployeeDbRow[];
    const deptIds = [...new Set(rows.map((r) => r.department_id).filter((d): d is string => d != null))];
    const deptNameById = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: depts, error: deptErr } = await this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', ctx.companyId)
        .in('id', deptIds);
      if (deptErr) {
        this.logger.error('Failed to load department names', deptErr.message);
        throw new InternalServerErrorException(deptErr.message);
      }
      for (const d of depts ?? []) {
        deptNameById.set((d as { id: string; name: string }).id, (d as { id: string; name: string }).name);
      }
    }

    const empIds = rows.map((r) => r.id);
    const portalLinked = new Set<string>();
    if (empIds.length > 0) {
      const { data: profiles } = await this.supabase
        .from('users')
        .select('linked_employee_id')
        .eq('company_id', ctx.companyId)
        .not('linked_employee_id', 'is', null)
        .in('linked_employee_id', empIds);
      for (const p of profiles ?? []) {
        const lid = (p as { linked_employee_id: string }).linked_employee_id;
        if (lid) portalLinked.add(lid);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      department_id: r.department_id,
      department_name: (r.department_id ? deptNameById.get(r.department_id) : undefined) ?? '—',
      created_at: r.created_at,
      gmail_connected: (r.gmail_status ?? 'EXPIRED') === 'CONNECTED',
      gmail_status: (r.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      last_synced_at: r.last_synced_at ?? null,
      sla_hours_default: r.sla_hours_default ?? null,
      tracking_start_at: r.tracking_start_at ?? null,
      has_portal_login: portalLinked.has(r.id),
      tracking_paused: r.tracking_paused === true,
      ai_enabled: r.ai_enabled !== false,
      mailbox_type: (r.mailbox_type as 'TEAM' | null | undefined) ?? null,
    }));
  }

  /**
   * TEAM / org mailboxes company-wide (excludes `mailbox_type = SELF`).
   * Merged into the CEO My Email API so manager-connected inboxes appear alongside CEO-added mailboxes.
   */
  async listTeamMailboxesAcrossCompany(companyId: string): Promise<OrgEmployeeDto[]> {
    const teamResult = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled, mailbox_type',
      )
      .eq('company_id', companyId)
      .or('mailbox_type.is.null,mailbox_type.eq.TEAM')
      .order('name', { ascending: true });

    let data = teamResult.data as EmployeeDbRow[] | null;
    let error = teamResult.error;
    if (error && this.isMissingMailboxTypeColumn(error)) {
      this.logger.warn(
        'listTeamMailboxesAcrossCompany: mailbox_type unavailable, listing all company mailboxes (apply migration 013)',
      );
      const r2 = await this.supabase
        .from('employees')
        .select(
          'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled',
        )
        .eq('company_id', companyId)
        .order('name', { ascending: true });
      if (r2.error) {
        this.logger.error('Failed to list team mailboxes (legacy)', r2.error.message);
        throw new InternalServerErrorException(r2.error.message);
      }
      data = (r2.data ?? []) as EmployeeDbRow[] | null;
      error = null;
    } else if (error) {
      this.logger.error('Failed to list team mailboxes', error.message);
      throw new InternalServerErrorException(error.message);
    }

    const rows = (data ?? []) as EmployeeDbRow[];
    const deptIds = [...new Set(rows.map((r) => r.department_id).filter((d): d is string => d != null))];
    const deptNameById = new Map<string, string>();
    if (deptIds.length > 0) {
      const { data: depts, error: deptErr } = await this.supabase
        .from('departments')
        .select('id, name')
        .eq('company_id', companyId)
        .in('id', deptIds);
      if (deptErr) {
        this.logger.error('Failed to load department names', deptErr.message);
        throw new InternalServerErrorException(deptErr.message);
      }
      for (const d of depts ?? []) {
        deptNameById.set((d as { id: string; name: string }).id, (d as { id: string; name: string }).name);
      }
    }

    const empIds = rows.map((r) => r.id);
    const portalLinked = new Set<string>();
    if (empIds.length > 0) {
      const { data: profiles } = await this.supabase
        .from('users')
        .select('linked_employee_id')
        .eq('company_id', companyId)
        .not('linked_employee_id', 'is', null)
        .in('linked_employee_id', empIds);
      for (const p of profiles ?? []) {
        const lid = (p as { linked_employee_id: string }).linked_employee_id;
        if (lid) portalLinked.add(lid);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      department_id: r.department_id,
      department_name: (r.department_id ? deptNameById.get(r.department_id) : undefined) ?? '—',
      created_at: r.created_at,
      gmail_connected: (r.gmail_status ?? 'EXPIRED') === 'CONNECTED',
      gmail_status: (r.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      last_synced_at: r.last_synced_at ?? null,
      sla_hours_default: r.sla_hours_default ?? null,
      tracking_start_at: r.tracking_start_at ?? null,
      has_portal_login: portalLinked.has(r.id),
      tracking_paused: r.tracking_paused === true,
      ai_enabled: r.ai_enabled !== false,
      mailbox_type: (r.mailbox_type as 'TEAM' | null | undefined) ?? null,
    }));
  }

  /**
   * Department manager inboxes for CEO "My Email": `users` rows with role HEAD
   * (linked employee row and/or manager work email).
   */
  async getManagerMailboxIndicators(companyId: string): Promise<{
    linkedEmployeeIds: Set<string>;
    emailsNormalized: Set<string>;
  }> {
    const { data, error } = await this.supabase
      .from('users')
      .select('email, linked_employee_id')
      .eq('company_id', companyId)
      .eq('role', 'HEAD');
    if (error) {
      this.logger.error('getManagerMailboxIndicators', error.message);
      return { linkedEmployeeIds: new Set(), emailsNormalized: new Set() };
    }
    const linkedEmployeeIds = new Set<string>();
    const emailsNormalized = new Set<string>();
    for (const row of data ?? []) {
      const r = row as { email?: string; linked_employee_id?: string | null };
      if (r.linked_employee_id) linkedEmployeeIds.add(r.linked_employee_id);
      if (r.email) emailsNormalized.add(String(r.email).trim().toLowerCase());
    }
    return { linkedEmployeeIds, emailsNormalized };
  }

  async updateEmployeePauses(
    ctx: RequestContext,
    employeeId: string,
    body: { tracking_paused?: boolean; ai_enabled?: boolean },
  ): Promise<OrgEmployeeDto> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot update mailbox pauses');
    }
    if (
      body.tracking_paused === undefined &&
      body.ai_enabled === undefined
    ) {
      throw new BadRequestException('Provide tracking_paused and/or ai_enabled');
    }

    const { data: row, error } = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled',
      )
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to load employee for pause update', error.message);
      throw error;
    }
    if (!row) {
      throw new NotFoundException('Employee not found');
    }
    const dbRow = row as EmployeeDbRow;
    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || dbRow.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only update pauses for employees in your department');
      }
    }

    const patch: { tracking_paused?: boolean; ai_enabled?: boolean } = {};
    if (typeof body.tracking_paused === 'boolean') {
      patch.tracking_paused = body.tracking_paused;
    }
    if (typeof body.ai_enabled === 'boolean') {
      patch.ai_enabled = body.ai_enabled;
    }

    const { data: updated, error: updErr } = await this.supabase
      .from('employees')
      .update(patch)
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled',
      )
      .single();

    if (updErr) {
      this.logger.error('Failed to update employee pauses', updErr.message);
      throw updErr;
    }

    const u = updated as EmployeeDbRow;
    const deptName = await this.getDepartmentName(ctx.companyId, u.department_id);
    const { data: portalRows } = await this.supabase
      .from('users')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('linked_employee_id', employeeId)
      .limit(1);
    const hasPortal = (portalRows?.length ?? 0) > 0;

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      department_id: u.department_id,
      department_name: deptName,
      created_at: u.created_at,
      gmail_connected: (u.gmail_status ?? 'EXPIRED') === 'CONNECTED',
      gmail_status: (u.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      last_synced_at: u.last_synced_at ?? null,
      sla_hours_default: u.sla_hours_default ?? null,
      tracking_start_at: u.tracking_start_at ?? null,
      has_portal_login: hasPortal,
      tracking_paused: u.tracking_paused === true,
      ai_enabled: u.ai_enabled !== false,
    };
  }

  async updateEmployeeSla(
    ctx: RequestContext,
    employeeId: string,
    slaHours: number,
  ): Promise<OrgEmployeeDto> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot update SLA');
    }
    const roundedSla = Math.round(slaHours);
    if (!Number.isFinite(roundedSla) || roundedSla < 1 || roundedSla > 168) {
      throw new BadRequestException('sla_hours must be between 1 and 168');
    }
    const { data: row, error } = await this.supabase
      .from('employees')
      .select('id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at')
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load employee for SLA update', error.message);
      throw error;
    }
    if (!row) {
      throw new NotFoundException('Employee not found');
    }
    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || row.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only update SLA for employees in your department');
      }
    }
    const { data: updated, error: updErr } = await this.supabase
      .from('employees')
      .update({ sla_hours_default: roundedSla })
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .select('id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at')
      .single();
    if (updErr) {
      this.logger.error('Failed to update employee SLA', updErr.message);
      throw updErr;
    }
    const deptName = await this.getDepartmentName(ctx.companyId, (updated as EmployeeDbRow).department_id);
    return this.toOrgDto(updated as EmployeeDbRow, deptName);
  }

  async listRecentReceivedMessages(
    ctx: RequestContext,
    employeeId: string,
    limit = 10,
  ): Promise<EmployeeMessageDto[]> {
    const { data: employee, error } = await this.supabase
      .from('employees')
      .select('id, department_id, company_id')
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load employee for message list', error.message);
      throw error;
    }
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || employee.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only view messages for employees in your department');
      }
    }
    if (ctx.role === 'EMPLOYEE') {
      if (!ctx.employeeId || ctx.employeeId !== employeeId) {
        throw new ForbiddenException('You can only view your own messages');
      }
    }
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const { data: messages, error: msgErr } = await this.supabase
      .from('email_messages')
      .select('provider_message_id, subject, from_email, sent_at')
      .eq('company_id', ctx.companyId)
      .eq('employee_id', employeeId)
      .eq('direction', 'INBOUND')
      .order('sent_at', { ascending: false })
      .limit(safeLimit);
    if (msgErr) {
      this.logger.error('Failed to list employee messages', msgErr.message);
      throw msgErr;
    }
    return (messages ?? []) as EmployeeMessageDto[];
  }

  /**
   * Paginated ingested mail for the Email Archive UI. Scoped by role (CEO / HEAD / EMPLOYEE).
   */
  async listMailArchive(
    ctx: RequestContext,
    opts: { limit: number; offset: number; employeeId?: string },
  ): Promise<{ total: number; items: MailArchiveItem[] }> {
    const allowedIds = await this.resolveMailArchiveEmployeeIds(ctx, opts.employeeId);
    if (allowedIds.length === 0) {
      return { total: 0, items: [] };
    }

    const safeLimit = Math.min(100, Math.max(1, opts.limit));
    const safeOffset = Math.max(0, opts.offset);

    const base = this.supabase
      .from('email_messages')
      .select('*', { count: 'exact' })
      .eq('company_id', ctx.companyId)
      .in('employee_id', allowedIds)
      .order('sent_at', { ascending: false });

    const { data: rows, error, count } = await base.range(safeOffset, safeOffset + safeLimit - 1);
    if (error) {
      this.logger.error('Failed to list mail archive', error.message);
      throw error;
    }

    const messages = (rows ?? []) as Array<{
      provider_message_id: string;
      provider_thread_id: string;
      subject: string;
      from_email: string;
      direction: string;
      body_text: string;
      sent_at: string;
      employee_id: string;
    }>;

    const empIds = [...new Set(messages.map((m) => m.employee_id))];
    const nameById = new Map<string, string>();
    if (empIds.length > 0) {
      const { data: emps } = await this.supabase
        .from('employees')
        .select('id, name')
        .eq('company_id', ctx.companyId)
        .in('id', empIds);
      for (const e of (emps ?? []) as Array<{ id: string; name: string }>) {
        nameById.set(e.id, e.name);
      }
    }

    const items: MailArchiveItem[] = messages.map((m) => ({
      provider_message_id: m.provider_message_id,
      provider_thread_id: m.provider_thread_id,
      subject: m.subject || '(no subject)',
      from_email: m.from_email,
      direction: m.direction,
      sent_at: m.sent_at,
      employee_id: m.employee_id,
      employee_name: nameById.get(m.employee_id) ?? 'Unknown',
      body_preview: (m.body_text ?? '').slice(0, 1500),
    }));

    return { total: count ?? items.length, items };
  }

  private async resolveMailArchiveEmployeeIds(
    ctx: RequestContext,
    filterEmployeeId?: string,
  ): Promise<string[]> {
    if (ctx.role === 'EMPLOYEE') {
      const self = ctx.employeeId;
      if (!self) return [];
      if (filterEmployeeId && filterEmployeeId !== self) {
        throw new ForbiddenException('You can only view your own email archive');
      }
      return [self];
    }

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId) return [];
      const { data: emps } = await this.supabase
        .from('employees')
        .select('id')
        .eq('company_id', ctx.companyId)
        .eq('department_id', ctx.departmentId)
        .eq('is_active', true);
      let ids = ((emps ?? []) as Array<{ id: string }>).map((e) => e.id);
      if (filterEmployeeId) {
        if (!ids.includes(filterEmployeeId)) {
          throw new ForbiddenException('Employee is outside your department');
        }
        ids = [filterEmployeeId];
      }
      return ids;
    }

    const { data: emps } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('is_active', true);
    let ids = ((emps ?? []) as Array<{ id: string }>).map((e) => e.id);
    if (filterEmployeeId) {
      if (!ids.includes(filterEmployeeId)) {
        throw new NotFoundException('Employee not found');
      }
      ids = [filterEmployeeId];
    }
    return ids;
  }

  async updateEmployeeTrackingStart(
    ctx: RequestContext,
    employeeId: string,
    startAtIso: string,
  ): Promise<OrgEmployeeDto> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot update tracking window');
    }
    const parsed = new Date(startAtIso);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('tracking_start_at must be a valid datetime');
    }
    const { data: row, error } = await this.supabase
      .from('employees')
      .select('id, department_id, company_id')
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load employee for tracking start update', error.message);
      throw error;
    }
    if (!row) {
      throw new NotFoundException('Employee not found');
    }
    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || row.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only update employees in your department');
      }
    }
    const iso = parsed.toISOString();
    const { data: updated, error: updErr } = await this.supabase
      .from('employees')
      .update({ tracking_start_at: iso })
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .select('id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at')
      .single();
    if (updErr) {
      this.logger.error('Failed to update tracking start', updErr.message);
      throw updErr;
    }
    await this.supabase
      .from('mail_sync_state')
      .upsert(
        {
          employee_id: employeeId,
          start_date: iso,
          last_processed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'employee_id' },
      );
    const deptName = await this.getDepartmentName(ctx.companyId, (updated as EmployeeDbRow).department_id);
    return this.toOrgDto(updated as EmployeeDbRow, deptName);
  }

  async deleteOrgEmployee(ctx: RequestContext, employeeId: string): Promise<void> {
    if (ctx.role === 'EMPLOYEE') {
      throw new ForbiddenException('Employees cannot delete records');
    }

    const { data: row, error } = await this.supabase
      .from('employees')
      .select('id, department_id, company_id')
      .eq('company_id', ctx.companyId)
      .eq('id', employeeId)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to load employee for delete', error.message);
      throw error;
    }
    if (!row) {
      throw new NotFoundException('Employee not found');
    }

    if (ctx.role === 'HEAD') {
      if (!ctx.departmentId || row.department_id !== ctx.departmentId) {
        throw new ForbiddenException('You can only delete employees in your department');
      }
    }

    const { data: loginRows } = await this.supabase.from('users').select('id').eq('linked_employee_id', employeeId);
    for (const u of loginRows ?? []) {
      const uid = (u as { id: string }).id;
      const { error: delUserErr } = await this.supabase.from('users').delete().eq('id', uid);
      if (delUserErr) {
        this.logger.error(`delete users row ${uid}: ${delUserErr.message}`);
        throw delUserErr;
      }
      await this.safeDeleteAuthUser(uid);
    }

    const { error: delErr } = await this.supabase.from('employees').delete().eq('id', employeeId).eq('company_id', ctx.companyId);
    if (delErr) {
      this.logger.error('Failed to delete employee', delErr.message);
      throw delErr;
    }
  }

  private async assertDepartmentInCompany(companyId: string, departmentId: string): Promise<{ id: string; name: string }> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('id, name, company_id')
      .eq('id', departmentId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to validate department', error.message);
      throw error;
    }
    if (!data) {
      throw new BadRequestException('Department does not exist or is not in your company');
    }
    return data as { id: string; name: string };
  }

  private toOrgDto(row: EmployeeDbRow, departmentName: string): OrgEmployeeDto {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      department_id: row.department_id,
      department_name: departmentName,
      created_at: row.created_at,
      sla_hours_default: row.sla_hours_default ?? null,
      tracking_start_at: row.tracking_start_at ?? null,
    };
  }

  private async getDepartmentName(companyId: string, departmentId: string | null): Promise<string> {
    if (!departmentId) return '—';
    const { data } = await this.supabase
      .from('departments')
      .select('name')
      .eq('company_id', companyId)
      .eq('id', departmentId)
      .maybeSingle();
    return (data as { name?: string } | null)?.name ?? '—';
  }

  // --- Compatibility for ingestion / conversations (tracked mailboxes) ---

  async listActive(companyId: string): Promise<Employee[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, sla_hours_default, is_active, ai_enabled, tracking_start_at, tracking_paused',
      )
      .eq('company_id', companyId)
      .eq('is_active', true);

    if (error) {
      this.logger.error('Failed to list employees', error.message);
      throw error;
    }

    return (data as EmployeeDbRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      companyId: row.company_id,
      departmentId: row.department_id ?? undefined,
      active: row.is_active !== false,
      slaHoursDefault: row.sla_hours_default ?? undefined,
      aiEnabled: row.ai_enabled !== false,
      trackingStartAt: row.tracking_start_at ?? null,
      trackingPaused: row.tracking_paused === true,
    }));
  }

  async getById(companyId: string, employeeId: string): Promise<Employee | null> {
    const { data, error } = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, sla_hours_default, is_active, ai_enabled, tracking_start_at, tracking_paused',
      )
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();

    if (error) {
      return null;
    }
    if (!data) return null;

    const row = data as EmployeeDbRow;
    const { data: sync } = await this.supabase
      .from('mail_sync_state')
      .select('start_date')
      .eq('employee_id', employeeId)
      .maybeSingle();

    const syncStart = (sync as { start_date: string } | null)?.start_date ?? null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      companyId: row.company_id,
      departmentId: row.department_id ?? undefined,
      active: row.is_active !== false,
      slaHoursDefault: row.sla_hours_default ?? undefined,
      aiEnabled: row.ai_enabled !== false,
      trackingStartAt: row.tracking_start_at ?? syncStart,
      trackingPaused: row.tracking_paused === true,
      startTrackingAt: row.tracking_start_at ?? syncStart,
    };
  }

  async getTrackingState(
    companyId: string,
    employeeId: string,
  ): Promise<{ trackingPaused: boolean; trackingStartAt: string | null } | null> {
    const { data: emp } = await this.supabase
      .from('employees')
      .select('id, tracking_paused, tracking_start_at')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();
    if (!emp) return null;

    const row = emp as { tracking_paused: boolean; tracking_start_at: string | null };
    const { data: sync } = await this.supabase
      .from('mail_sync_state')
      .select('start_date')
      .eq('employee_id', employeeId)
      .maybeSingle();
    const syncStart = (sync as { start_date: string } | null)?.start_date ?? null;

    return {
      trackingPaused: row.tracking_paused === true,
      trackingStartAt: row.tracking_start_at ?? syncStart,
    };
  }

  async isAutoAiEnabledForEmployee(companyId: string, employeeId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('employees')
      .select('ai_enabled')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();
    const row = data as { ai_enabled: boolean } | null;
    return row?.ai_enabled !== false;
  }

  /** True when an Employee-portal user (role EMPLOYEE) is linked to this tracked mailbox. */
  async hasPortalEmployeeLink(companyId: string, employeeId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('users')
      .select('id')
      .eq('company_id', companyId)
      .eq('linked_employee_id', employeeId)
      .eq('role', 'EMPLOYEE')
      .limit(1)
      .maybeSingle();
    if (error) {
      this.logger.warn(`hasPortalEmployeeLink: ${error.message}`);
      return false;
    }
    return data != null;
  }

  getSlaHours(employee: Employee, globalDefault = 24): number {
    return employee.slaHoursDefault ?? globalDefault;
  }

  // ── Self-tracking (CEO / Manager mailbox) helpers ──

  async listSelfTracked(companyId: string): Promise<OrgEmployeeDto[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select(
        'id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at, tracking_paused, ai_enabled, mailbox_type',
      )
      .eq('company_id', companyId)
      .eq('mailbox_type', 'SELF')
      .order('name', { ascending: true });

    if (error && this.isMissingMailboxTypeColumn(error)) {
      this.logger.warn('listSelfTracked: mailbox_type unavailable, returning none (apply migration 013)');
      return [];
    }
    if (error) {
      this.logger.error('Failed to list self-tracked mailboxes', error.message);
      throw new InternalServerErrorException(error.message);
    }

    const rows = (data ?? []) as EmployeeDbRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      department_id: r.department_id,
      department_name: '—',
      created_at: r.created_at,
      gmail_connected: (r.gmail_status ?? 'EXPIRED') === 'CONNECTED',
      gmail_status: (r.gmail_status ?? 'EXPIRED') as 'CONNECTED' | 'EXPIRED' | 'REVOKED',
      last_synced_at: r.last_synced_at ?? null,
      sla_hours_default: r.sla_hours_default ?? null,
      tracking_start_at: r.tracking_start_at ?? null,
      tracking_paused: r.tracking_paused === true,
      ai_enabled: r.ai_enabled !== false,
      mailbox_type: 'SELF' as const,
    }));
  }

  async createSelfTrackedMailbox(
    companyId: string,
    userId: string,
    dto: { name: string; email: string; departmentId?: string },
  ): Promise<OrgEmployeeDto> {
    const name = dto.name.trim();
    const email = dto.email.trim().toLowerCase();
    if (!name || !email) {
      throw new BadRequestException('name and email are required');
    }

    const startIso = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('employees')
      .insert({
        name,
        email,
        company_id: companyId,
        department_id: dto.departmentId ?? null,
        created_by: userId,
        is_active: true,
        ai_enabled: true,
        tracking_paused: false,
        tracking_start_at: startIso,
        mailbox_type: 'SELF',
      })
      .select('id, name, email, company_id, department_id, created_by, created_at, gmail_status, last_synced_at, sla_hours_default, tracking_start_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('A mailbox with this email already exists in your company');
      }
      if (this.isMissingMailboxTypeColumn(error)) {
        throw new BadRequestException(
          'Database is missing column employees.mailbox_type. Apply migration 013_self_tracking_mailboxes.sql',
        );
      }
      this.logger.error('Failed to create self-tracked mailbox', error.message);
      throw new InternalServerErrorException(error.message);
    }

    const row = data as EmployeeDbRow;
    await this.ensureMailSyncState(row.id, startIso);

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      department_id: row.department_id,
      department_name: '—',
      created_at: row.created_at,
      sla_hours_default: row.sla_hours_default ?? null,
      tracking_start_at: row.tracking_start_at ?? null,
      mailbox_type: 'SELF',
    };
  }

  async deleteSelfTrackedMailbox(companyId: string, mailboxId: string): Promise<void> {
    const { data: row, error } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', mailboxId)
      .eq('mailbox_type', 'SELF')
      .maybeSingle();

    if (error) {
      if (this.isMissingMailboxTypeColumn(error)) {
        throw new BadRequestException(
          'Database is missing column employees.mailbox_type. Apply migration 013_self_tracking_mailboxes.sql',
        );
      }
      this.logger.error('Failed to load self-tracked mailbox for delete', error.message);
      throw new InternalServerErrorException(error.message);
    }
    if (!row) {
      throw new NotFoundException('Self-tracked mailbox not found');
    }

    const { error: delErr } = await this.supabase
      .from('employees')
      .delete()
      .eq('id', mailboxId)
      .eq('company_id', companyId)
      .eq('mailbox_type', 'SELF');

    if (delErr) {
      this.logger.error('Failed to delete self-tracked mailbox', delErr.message);
      throw new InternalServerErrorException(delErr.message);
    }
  }

  async getMailboxType(employeeId: string): Promise<string> {
    const { data } = await this.supabase
      .from('employees')
      .select('mailbox_type')
      .eq('id', employeeId)
      .maybeSingle();
    return (data as { mailbox_type?: string } | null)?.mailbox_type ?? 'TEAM';
  }
}
