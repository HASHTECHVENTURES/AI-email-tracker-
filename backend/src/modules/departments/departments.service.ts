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

  async rename(companyId: string, id: string, name: string): Promise<DepartmentRow> {
    const { data, error } = await this.supabase
      .from('departments')
      .update({ name: name.trim() })
      .eq('company_id', companyId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) {
      this.logger.error('Failed to rename department', error.message);
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
    const { data: mem, error: memErr } = await this.supabase
      .from('manager_department_memberships')
      .select('user_id')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .limit(1)
      .maybeSingle();

    if (memErr) {
      this.logger.warn(`getDepartmentManager memberships: ${memErr.message}`);
    }

    const memUserId = (mem as { user_id?: string } | null)?.user_id;
    if (memUserId) {
      const { data: u, error } = await this.supabase
        .from('users')
        .select('id, email, full_name')
        .eq('id', memUserId)
        .eq('company_id', companyId)
        .eq('role', 'HEAD')
        .maybeSingle();
      if (error) {
        this.logger.error('Failed to load department manager', error.message);
        throw error;
      }
      return (u as DepartmentManagerSummary | null) ?? null;
    }

    const { data, error } = await this.supabase
      .from('users')
      .select('id, email, full_name')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .eq('role', 'HEAD')
      .maybeSingle();
    if (error) {
      this.logger.error('Failed to load department manager (legacy)', error.message);
      throw error;
    }
    return (data as DepartmentManagerSummary | null) ?? null;
  }

  async listWithEmployeeCounts(
    companyId: string,
  ): Promise<(DepartmentRow & { employee_count: number; manager: DepartmentManagerSummary | null })[]> {
    const depts = await this.list(companyId);
    const withCounts = await Promise.all(
      depts.map(async (d) => {
        const [manager, employee_count] = await Promise.all([
          this.getDepartmentManager(companyId, d.id),
          this.countEmployees(companyId, d.id),
        ]);
        if (manager) {
          await this.ensureManagerTrackedMailboxAfterAssignment(companyId, d.id, manager);
        }
        return { ...d, employee_count, manager };
      }),
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
      const uid = (insertedUser as { id: string }).id;
      await this.clearDepartmentManagerMemberships(companyId, departmentId);
      const { error: memInsErr } = await this.supabase.from('manager_department_memberships').insert({
        user_id: uid,
        department_id: departmentId,
        company_id: companyId,
      });
      if (memInsErr) {
        this.logger.error('Failed to insert manager_department_memberships', memInsErr.message);
        throw memInsErr;
      }
      const out = insertedUser as {
        id: string;
        email: string;
        full_name: string | null;
        role: string;
        department_id: string | null;
      };
      await this.ensureManagerTrackedMailboxAfterAssignment(companyId, departmentId, out);
      return out;
    }

    const existingRow = user as {
      id: string;
      department_id: string | null;
    };

    await this.clearDepartmentManagerMemberships(companyId, departmentId);
    const { error: memUpsertErr } = await this.supabase.from('manager_department_memberships').upsert(
      {
        user_id: existingRow.id,
        department_id: departmentId,
        company_id: companyId,
      },
      { onConflict: 'user_id,department_id' },
    );
    if (memUpsertErr) {
      this.logger.error('Failed to upsert manager_department_memberships', memUpsertErr.message);
      throw memUpsertErr;
    }

    const { data: updated, error: updErr } = await this.supabase
      .from('users')
      .update({
        role: 'HEAD',
        ...(existingRow.department_id ? {} : { department_id: departmentId }),
      })
      .eq('id', existingRow.id)
      .eq('company_id', companyId)
      .select('id, email, full_name, role, department_id')
      .single();
    if (updErr) {
      this.logger.error('Failed to assign manager role', updErr.message);
      throw updErr;
    }
    const out = updated as {
      id: string;
      email: string;
      full_name: string | null;
      role: string;
      department_id: string | null;
    };
    await this.ensureManagerTrackedMailboxAfterAssignment(companyId, departmentId, out);
    return out;
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
   * CEO Manager mail and Gmail sync use `employees` rows. Historically `assignManager` only wrote
   * `users` + `manager_department_memberships`, so department heads were missing from mailboxes.
   */
  private async ensureManagerTrackedMailboxAfterAssignment(
    companyId: string,
    departmentId: string,
    manager: { id: string; email: string; full_name: string | null },
  ): Promise<void> {
    const email = manager.email.trim().toLowerCase();
    if (!email) return;

    const { data: inDept, error: deptErr } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('department_id', departmentId)
      .eq('email', email)
      .maybeSingle();
    if (deptErr) {
      this.logger.warn(`ensureManagerTrackedMailbox: dept lookup ${deptErr.message}`);
      return;
    }
    if (inDept) return;

    const name =
      manager.full_name?.trim() ||
      email.split('@')[0] ||
      'Manager';

    const { data: primaryRows, error: primErr } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('email', email)
      .eq('is_active', true)
      .eq('roster_duplicate', false);
    if (primErr) {
      this.logger.warn(`ensureManagerTrackedMailbox: primary lookup ${primErr.message}`);
      return;
    }
    const hasPrimaryElsewhere = ((primaryRows ?? []) as { id: string }[]).length > 0;
    const roster_duplicate = hasPrimaryElsewhere;

    const payload: Record<string, unknown> = {
      name,
      email,
      company_id: companyId,
      department_id: departmentId,
      created_by: manager.id,
      is_active: true,
      ai_enabled: true,
      tracking_paused: true,
      tracking_start_at: null,
      mailbox_type: 'TEAM',
      roster_duplicate,
    };

    let ins = await this.supabase.from('employees').insert(payload).select('id').single();
    if (ins.error && this.isMissingMailboxTypeColumn(ins.error)) {
      const { mailbox_type: _m, ...rest } = payload;
      ins = await this.supabase.from('employees').insert(rest).select('id').single();
    }
    if (ins.error) {
      if ((ins.error as { code?: string }).code === '23505') return;
      this.logger.warn(`ensureManagerTrackedMailbox: insert ${ins.error.message}`);
    }
  }

  private async clearDepartmentManagerMemberships(companyId: string, departmentId: string): Promise<void> {
    const { error } = await this.supabase
      .from('manager_department_memberships')
      .delete()
      .eq('company_id', companyId)
      .eq('department_id', departmentId);
    if (error) {
      this.logger.warn(`clearDepartmentManagerMemberships: ${error.message}`);
    }
  }

  private async safeDeleteAuthUser(userId: string): Promise<void> {
    try {
      const { error } = await this.supabase.auth.admin.deleteUser(userId);
      if (error) {
        this.logger.warn(`delete auth user ${userId}: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(`delete auth user ${userId}: ${(err as Error).message}`);
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

  async deleteWithCleanup(companyId: string, id: string): Promise<void> {
    const [membershipManagers, legacyManagers, teamRows] = await Promise.all([
      this.supabase
        .from('manager_department_memberships')
        .select('user_id')
        .eq('company_id', companyId)
        .eq('department_id', id),
      this.supabase
        .from('users')
        .select('id')
        .eq('company_id', companyId)
        .eq('role', 'HEAD')
        .eq('department_id', id),
      this.supabase
        .from('employees')
        .select('id')
        .eq('company_id', companyId)
        .eq('department_id', id),
    ]);

    if (membershipManagers.error) {
      this.logger.warn(`Failed to load manager memberships for dept ${id}: ${membershipManagers.error.message}`);
    }
    if (legacyManagers.error) {
      this.logger.warn(`Failed to load legacy managers for dept ${id}: ${legacyManagers.error.message}`);
    }
    if (teamRows.error) {
      this.logger.warn(`Failed to load team employees for dept ${id}: ${teamRows.error.message}`);
    }

    const managerIds = new Set<string>();
    for (const row of membershipManagers.data ?? []) {
      const uid = (row as { user_id?: string }).user_id;
      if (uid) managerIds.add(uid);
    }
    for (const row of legacyManagers.data ?? []) {
      const uid = (row as { id?: string }).id;
      if (uid) managerIds.add(uid);
    }

    const employeeIds = (teamRows.data ?? [])
      .map((row) => (row as { id?: string }).id)
      .filter((employeeId): employeeId is string => Boolean(employeeId));

    if (employeeIds.length > 0) {
      const { data: linkedUsers, error: linkedErr } = await this.supabase
        .from('users')
        .select('id')
        .eq('company_id', companyId)
        .in('linked_employee_id', employeeIds);
      if (linkedErr) {
        this.logger.warn(`Failed to load linked employee users for dept ${id}: ${linkedErr.message}`);
      }
      for (const row of linkedUsers ?? []) {
        const uid = (row as { id?: string }).id;
        if (!uid) continue;
        const { error: delProfileErr } = await this.supabase
          .from('users')
          .delete()
          .eq('company_id', companyId)
          .eq('id', uid);
        if (delProfileErr) {
          this.logger.warn(`Failed to delete employee profile ${uid}: ${delProfileErr.message}`);
          continue;
        }
        await this.safeDeleteAuthUser(uid);
      }

      const { error: empDelErr } = await this.supabase
        .from('employees')
        .delete()
        .eq('company_id', companyId)
        .eq('department_id', id);
      if (empDelErr) {
        this.logger.warn(`Failed to delete team employees for dept ${id}: ${empDelErr.message}`);
      }
    }

    const { error: memErr } = await this.supabase
      .from('manager_department_memberships')
      .delete()
      .eq('company_id', companyId)
      .eq('department_id', id);
    if (memErr) {
      this.logger.warn(`Failed to clear manager_department_memberships for dept ${id}: ${memErr.message}`);
    }

    for (const managerId of managerIds) {
      const { data: profile, error: profileErr } = await this.supabase
        .from('users')
        .select('id, role, department_id, linked_employee_id')
        .eq('company_id', companyId)
        .eq('id', managerId)
        .maybeSingle();
      if (profileErr || !profile) {
        if (profileErr) this.logger.warn(`Failed to load manager ${managerId}: ${profileErr.message}`);
        continue;
      }

      const { data: remainingMems, error: remainingErr } = await this.supabase
        .from('manager_department_memberships')
        .select('department_id')
        .eq('company_id', companyId)
        .eq('user_id', managerId);
      if (remainingErr) {
        this.logger.warn(`Failed to load remaining manager memberships for ${managerId}: ${remainingErr.message}`);
      }

      const remainingDepartmentId = (remainingMems ?? [])[0]?.department_id as string | undefined;
      const currentDepartmentId = (profile as { department_id?: string | null }).department_id ?? null;
      const linkedEmployeeId = (profile as { linked_employee_id?: string | null }).linked_employee_id ?? null;

      if (remainingDepartmentId) {
        if (currentDepartmentId === id || !currentDepartmentId) {
          const { error: updateErr } = await this.supabase
            .from('users')
            .update({ department_id: remainingDepartmentId })
            .eq('company_id', companyId)
            .eq('id', managerId);
          if (updateErr) {
            this.logger.warn(`Failed to move manager ${managerId} to remaining dept: ${updateErr.message}`);
          }
        }
        continue;
      }

      if (linkedEmployeeId) {
        const { data: linkedEmp } = await this.supabase
          .from('employees')
          .select('department_id')
          .eq('company_id', companyId)
          .eq('id', linkedEmployeeId)
          .maybeSingle();
        const employeeDepartmentId = (linkedEmp as { department_id?: string | null } | null)?.department_id ?? null;
        const { error: demoteErr } = await this.supabase
          .from('users')
          .update({ role: 'EMPLOYEE', department_id: employeeDepartmentId })
          .eq('company_id', companyId)
          .eq('id', managerId);
        if (demoteErr) {
          this.logger.warn(`Failed to demote manager ${managerId}: ${demoteErr.message}`);
        }
        continue;
      }

      const { error: delProfileErr } = await this.supabase
        .from('users')
        .delete()
        .eq('company_id', companyId)
        .eq('id', managerId);
      if (delProfileErr) {
        this.logger.warn(`Failed to delete manager profile ${managerId}: ${delProfileErr.message}`);
        continue;
      }
      await this.safeDeleteAuthUser(managerId);
    }

    await this.delete(companyId, id);
  }
}
