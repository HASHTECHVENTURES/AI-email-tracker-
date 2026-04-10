import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import type { AuthedRequestUser } from '../../types/express';
import type { EmployeeRole } from '../common/types';
import { isPlatformAdminEmail } from '../platform-admin/platform-admin.guard';

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  company_id: string;
  role: EmployeeRole;
  department_id: string | null;
  linked_employee_id: string | null;
}

interface CompanyRow {
  name: string;
}

@Injectable()
export class SaasAuthService {
  private readonly logger = new Logger(SaasAuthService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** Labels for the team switcher (HEAD). */
  async getManagedDepartmentsSummary(
    companyId: string,
    departmentIds: string[],
  ): Promise<{ id: string; name: string }[]> {
    if (departmentIds.length === 0) return [];
    const { data, error } = await this.supabase
      .from('departments')
      .select('id, name')
      .eq('company_id', companyId)
      .in('id', departmentIds)
      .order('name', { ascending: true });
    if (error) {
      this.logger.warn(`getManagedDepartmentsSummary: ${error.message}`);
      return [];
    }
    return (data ?? []) as { id: string; name: string }[];
  }

  async findProfileByAuthId(authUserId: string): Promise<AuthedRequestUser | null> {
    const { data, error } = await this.supabase
      .from('users')
      .select('id, email, full_name, company_id, role, department_id, linked_employee_id')
      .eq('id', authUserId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(`Failed to load user profile: ${error.message}`);
    }
    if (!data) return null;
    const row = data as UserRow;
    const { data: company } = await this.supabase
      .from('companies')
      .select('name')
      .eq('id', row.company_id)
      .maybeSingle();
    const companyName = (company as CompanyRow | null)?.name ?? null;
    let linkedEmployeeId = row.linked_employee_id ?? null;
    if (row.role === 'EMPLOYEE' && !linkedEmployeeId) {
      const { data: emp } = await this.supabase
        .from('employees')
        .select('id')
        .eq('company_id', row.company_id)
        .eq('email', row.email.trim().toLowerCase())
        .maybeSingle();
      if (emp) {
        linkedEmployeeId = (emp as { id: string }).id;
      }
    }
    /**
     * HEAD: do **not** infer `linked_employee_id` from a same-email `employees` row.
     * Otherwise every manager who shares an email with any roster row gets the Manager/Mailbox
     * toggle and act-as-employee APIs without an explicit link. Mailbox view requires
     * `users.linked_employee_id` set (e.g. when the org links the manager to their mailbox).
     */

    let managedDepartmentIds: string[] = [];
    let resolvedDepartmentId: string | null = row.department_id ?? null;

    if (row.role === 'HEAD') {
      const { data: memRows, error: memErr } = await this.supabase
        .from('manager_department_memberships')
        .select('department_id')
        .eq('user_id', row.id);

      const fromMem: string[] =
        !memErr && memRows
          ? (memRows as { department_id: string }[]).map((m) => m.department_id)
          : [];
      if (memErr) {
        this.logger.warn(`manager_department_memberships load: ${memErr.message}`);
      }

      const idSet = new Set<string>(fromMem);
      if (row.department_id) {
        idSet.add(row.department_id);
      }
      managedDepartmentIds = [...idSet].sort();

      if (managedDepartmentIds.length > 0) {
        resolvedDepartmentId =
          row.department_id && idSet.has(row.department_id)
            ? row.department_id
            : (managedDepartmentIds[0] ?? null);
      } else {
        resolvedDepartmentId = row.department_id;
      }
    }

    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      companyId: row.company_id,
      companyName,
      role: row.role,
      departmentId: resolvedDepartmentId,
      managedDepartmentIds,
      linkedEmployeeId,
    };
  }

  async completeOnboarding(
    authUserId: string,
    email: string,
    fullName: string,
    companyName: string,
  ): Promise<{ user: AuthedRequestUser; created: boolean }> {
    const existing = await this.findProfileByAuthId(authUserId);
    if (existing) {
      return { user: existing, created: false };
    }

    const trimmedName = fullName.trim();
    const trimmedCompany = companyName.trim();
    if (!trimmedName || !trimmedCompany) {
      throw new BadRequestException('full_name and company_name are required');
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (isPlatformAdminEmail(normalizedEmail)) {
      throw new BadRequestException(
        'This email is listed in PLATFORM_ADMIN_EMAILS (platform operator). Use a different email to create a tenant company, or remove it from PLATFORM_ADMIN_EMAILS.',
      );
    }

    const { data: company, error: companyErr } = await this.supabase
      .from('companies')
      .insert({ name: trimmedCompany })
      .select('id')
      .single();

    if (companyErr || !company) {
      throw new BadRequestException(
        companyErr ? `Could not create company: ${companyErr.message}` : 'Could not create company',
      );
    }

    const companyId = (company as { id: string }).id;

    const { data: inserted, error: userErr } = await this.supabase
      .from('users')
      .insert({
        id: authUserId,
        email: normalizedEmail,
        full_name: trimmedName,
        company_id: companyId,
        role: 'CEO',
      })
      .select('id, email, full_name, company_id, role, department_id, linked_employee_id')
      .single();

    if (userErr || !inserted) {
      await this.supabase.from('companies').delete().eq('id', companyId);
      if (userErr?.code === '23505') {
        throw new BadRequestException(
          'This email is already registered. Sign in with that account instead of creating a new workspace.',
        );
      }
      throw new BadRequestException(
        userErr ? `Could not create user: ${userErr.message}` : 'Could not create user',
      );
    }

    const row = inserted as UserRow;
    return {
      user: {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        companyId: row.company_id,
        companyName: trimmedCompany,
        role: row.role,
        departmentId: row.department_id ?? null,
        managedDepartmentIds: [],
        linkedEmployeeId: row.linked_employee_id ?? null,
      },
      created: true,
    };
  }
}
