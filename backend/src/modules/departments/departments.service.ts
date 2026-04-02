import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

export interface DepartmentRow {
  id: string;
  company_id: string;
  name: string;
  parent_department_id: string | null;
  created_at: string;
}

export interface DepartmentManagerSummary {
  id: string;
  email: string;
  full_name: string | null;
}

@Injectable()
export class DepartmentsService {
  private readonly logger = new Logger(DepartmentsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async create(companyId: string, name: string): Promise<DepartmentRow> {
    const { data, error } = await this.supabase
      .from('departments')
      .insert({ company_id: companyId, name: name.trim() })
      .select('*')
      .single();
    if (error) {
      this.logger.error('Failed to create department', error.message);
      throw error;
    }
    return data as DepartmentRow;
  }

  async list(companyId: string): Promise<DepartmentRow[]> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('*')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.error('Failed to list departments', error.message);
      throw error;
    }
    return (data ?? []) as DepartmentRow[];
  }

  async getById(companyId: string, id: string): Promise<DepartmentRow | null> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load department', error.message);
      throw error;
    }
    return (data as DepartmentRow | null) ?? null;
  }

  async countEmployees(companyId: string, departmentId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('department_id', departmentId);
    if (error) {
      this.logger.error('Failed to count employees in department', error.message);
      throw error;
    }
    return count ?? 0;
  }

  async getDepartmentManager(
    companyId: string,
    departmentId: string,
  ): Promise<DepartmentManagerSummary | null> {
    const { data, error } = await this.supabase
      .from('users')
      .select('id, email, full_name')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .eq('role', 'HEAD')
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load department manager', error.message);
      throw error;
    }
    return (data as DepartmentManagerSummary | null) ?? null;
  }

  async listWithEmployeeCounts(
    companyId: string,
  ): Promise<(DepartmentRow & { employee_count: number; manager: DepartmentManagerSummary | null })[]> {
    const depts = await this.list(companyId);
    const withCounts = await Promise.all(
      depts.map(async (d) => ({
        ...d,
        employee_count: await this.countEmployees(companyId, d.id),
        manager: await this.getDepartmentManager(companyId, d.id),
      })),
    );
    return withCounts;
  }

  async assignManager(
    companyId: string,
    departmentId: string,
    email: string,
    options?: { fullName?: string; password?: string },
  ): Promise<{ id: string; email: string; full_name: string | null; role: string; department_id: string | null }> {
    const normalizedEmail = email.trim().toLowerCase();
    let { data: user, error: userErr } = await this.supabase
      .from('users')
      .select('id, email, full_name, role, department_id')
      .eq('company_id', companyId)
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (userErr) {
      this.logger.error('Failed to load user for manager assignment', userErr.message);
      throw userErr;
    }
    if (!user) {
      const password = options?.password?.trim();
      if (!password || password.length < 8) {
        throw new Error('PASSWORD_REQUIRED');
      }
      const fullName = options?.fullName?.trim() || null;

      const { data: createdAuth, error: authErr } = await this.supabase.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
      });
      if (authErr || !createdAuth.user?.id) {
        this.logger.error('Failed to create auth user for manager', authErr?.message ?? 'unknown');
        throw new Error('AUTH_USER_CREATE_FAILED');
      }

      const { data: insertedUser, error: insErr } = await this.supabase
        .from('users')
        .insert({
          id: createdAuth.user.id,
          email: normalizedEmail,
          full_name: fullName,
          company_id: companyId,
          role: 'HEAD',
          department_id: departmentId,
        })
        .select('id, email, full_name, role, department_id')
        .single();
      if (insErr || !insertedUser) {
        this.logger.error('Failed to insert manager user row', insErr?.message ?? 'unknown');
        throw new Error('MANAGER_PROFILE_CREATE_FAILED');
      }
      return insertedUser as {
        id: string;
        email: string;
        full_name: string | null;
        role: string;
        department_id: string | null;
      };
    }

    const { data: updated, error: updErr } = await this.supabase
      .from('users')
      .update({ role: 'HEAD', department_id: departmentId })
      .eq('id', (user as { id: string }).id)
      .eq('company_id', companyId)
      .select('id, email, full_name, role, department_id')
      .single();
    if (updErr) {
      this.logger.error('Failed to assign manager role', updErr.message);
      throw updErr;
    }
    return updated as {
      id: string;
      email: string;
      full_name: string | null;
      role: string;
      department_id: string | null;
    };
  }

  async resetManagerPassword(companyId: string, departmentId: string, newPassword: string): Promise<void> {
    const password = newPassword.trim();
    if (password.length < 8) {
      throw new Error('PASSWORD_TOO_SHORT');
    }
    const manager = await this.getDepartmentManager(companyId, departmentId);
    if (!manager) {
      throw new Error('MANAGER_NOT_FOUND');
    }
    const { error } = await this.supabase.auth.admin.updateUserById(manager.id, {
      password,
    });
    if (error) {
      this.logger.error('Failed to reset manager password', error.message);
      throw new Error('PASSWORD_RESET_FAILED');
    }
  }

  async delete(companyId: string, id: string): Promise<void> {
    const { error } = await this.supabase
      .from('departments')
      .delete()
      .eq('company_id', companyId)
      .eq('id', id);
    if (error) {
      this.logger.error('Failed to delete department', error.message);
      throw error;
    }
  }
}
