import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { Employee } from '../common/types';
import { SUPABASE_CLIENT } from '../common/supabase.provider';

interface EmployeeRow {
  id: string;
  name: string;
  email: string;
  provider: string;
  active: boolean;
  company_id: string | null;
  department_id: string | null;
  role: 'CEO' | 'HEAD' | 'EMPLOYEE';
  is_active: boolean;
  ai_enabled: boolean;
  tracking_start_at: string | null;
  tracking_paused: boolean;
  sla_hours_default: number | null;
  auto_ai_enabled: boolean | null;
  created_at: string;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async add(
    employee: Omit<Employee, 'active'> & {
      active?: boolean;
      startTrackingAt?: string;
      autoAiEnabled?: boolean;
      companyId: string;
      departmentId: string;
      role?: 'CEO' | 'HEAD' | 'EMPLOYEE';
      trackingPaused?: boolean;
    },
  ): Promise<Employee> {
    const { data, error } = await this.supabase
      .from('employees')
      .upsert(
        {
          id: employee.id,
          name: employee.name,
          email: employee.email,
          company_id: employee.companyId,
          department_id: employee.departmentId,
          role: employee.role ?? 'EMPLOYEE',
          is_active: employee.active ?? true,
          ai_enabled: employee.autoAiEnabled ?? true,
          tracking_start_at: employee.startTrackingAt ?? new Date().toISOString(),
          tracking_paused: employee.trackingPaused ?? false,
          active: employee.active ?? true,
          sla_hours_default: employee.slaHoursDefault ?? null,
          auto_ai_enabled: employee.autoAiEnabled ?? true,
        },
        { onConflict: 'id' },
      )
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to add employee', error.message);
      throw error;
    }

    const startIso =
      employee.startTrackingAt ?? new Date().toISOString();
    const existingSync = await this.getSyncStateRow(employee.id);
    if (!existingSync) {
      await this.upsertMailSyncStart(employee.id, startIso, null);
    }

    return this.toEmployee(data as EmployeeRow);
  }

  async updateSettings(
    companyId: string,
    employeeId: string,
    dto: {
      autoAiEnabled?: boolean;
      startTrackingAt?: string;
      slaHoursDefault?: number | null;
      trackingPaused?: boolean;
      departmentId?: string;
      role?: 'CEO' | 'HEAD' | 'EMPLOYEE';
    },
  ): Promise<Employee> {
    if ('slaHoursDefault' in dto && dto.slaHoursDefault !== undefined) {
      const v =
        dto.slaHoursDefault === null
          ? null
          : Math.min(168, Math.max(1, Math.round(dto.slaHoursDefault)));
      const { error } = await this.supabase
        .from('employees')
        .update({ sla_hours_default: v })
        .eq('company_id', companyId)
        .eq('id', employeeId);
      if (error) {
        this.logger.error('Failed to update employee SLA', error.message);
        throw error;
      }
    }

    if (dto.autoAiEnabled !== undefined) {
      const { error } = await this.supabase
        .from('employees')
        .update({ auto_ai_enabled: dto.autoAiEnabled, ai_enabled: dto.autoAiEnabled })
        .eq('company_id', companyId)
        .eq('id', employeeId);
      if (error) {
        this.logger.error('Failed to update employee AI flag', error.message);
        throw error;
      }
    }

    if (dto.startTrackingAt !== undefined) {
      const { error } = await this.supabase
        .from('employees')
        .update({ tracking_start_at: dto.startTrackingAt })
        .eq('company_id', companyId)
        .eq('id', employeeId);
      if (error) {
        this.logger.error('Failed to update employee tracking start', error.message);
        throw error;
      }
      const existing = await this.getSyncStateRow(employeeId);
      await this.upsertMailSyncStart(
        employeeId,
        dto.startTrackingAt,
        existing?.last_processed_at ?? null,
      );
    }

    if (dto.trackingPaused !== undefined) {
      const { error } = await this.supabase
        .from('employees')
        .update({ tracking_paused: dto.trackingPaused })
        .eq('company_id', companyId)
        .eq('id', employeeId);
      if (error) {
        this.logger.error('Failed to update tracking pause', error.message);
        throw error;
      }
    }

    if (dto.departmentId !== undefined || dto.role !== undefined) {
      const { error } = await this.supabase
        .from('employees')
        .update({
          department_id: dto.departmentId,
          role: dto.role,
        })
        .eq('company_id', companyId)
        .eq('id', employeeId);
      if (error) {
        this.logger.error('Failed to update employee org fields', error.message);
        throw error;
      }
    }

    const updated = await this.getById(companyId, employeeId);
    if (!updated) {
      throw new Error('Employee not found after update');
    }
    return updated;
  }

  async listActive(companyId: string): Promise<Employee[]> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .eq('active', true);

    if (error) {
      this.logger.error('Failed to list employees', error.message);
      throw error;
    }

    return (data as EmployeeRow[]).map(this.toEmployee);
  }

  /** Active employees with OAuth + sync + AI flags for the dashboard. */
  async listActiveWithOAuthStatus(companyId: string): Promise<Employee[]> {
    const employees = await this.listActive(companyId);
    if (employees.length === 0) {
      return [];
    }
    const ids = employees.map((e) => e.id);

    const { data: tokenRows, error: tokenErr } = await this.supabase
      .from('employee_oauth_tokens')
      .select('employee_id')
      .in('employee_id', ids);

    if (tokenErr) {
      this.logger.error('Failed to load oauth status for employees', tokenErr.message);
      throw tokenErr;
    }

    const { data: syncRows, error: syncErr } = await this.supabase
      .from('mail_sync_state')
      .select('employee_id, start_date')
      .in('employee_id', ids);

    if (syncErr) {
      this.logger.error('Failed to load mail sync state for employees', syncErr.message);
      throw syncErr;
    }

    const connected = new Set((tokenRows ?? []).map((r: { employee_id: string }) => r.employee_id));
    const startByEmp = new Map(
      (syncRows ?? []).map((r: { employee_id: string; start_date: string }) => [
        r.employee_id,
        r.start_date,
      ]),
    );

    return employees.map((e) => ({
      ...e,
      oauthConnected: connected.has(e.id),
      startTrackingAt: startByEmp.get(e.id) ?? null,
    }));
  }

  async getById(companyId: string, employeeId: string): Promise<Employee | null> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .single();

    if (error) {
      return null;
    }

    const row = data as EmployeeRow;
    const { data: sync } = await this.supabase
      .from('mail_sync_state')
      .select('start_date')
      .eq('employee_id', employeeId)
      .maybeSingle();

    const emp = this.toEmployee(row);
    emp.startTrackingAt = (sync as { start_date: string } | null)?.start_date ?? null;
    return emp;
  }

  /** True if employee-level AI is allowed (column defaults to true). */
  async isAutoAiEnabledForEmployee(companyId: string, employeeId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('employees')
      .select('auto_ai_enabled, ai_enabled')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();
    const row = data as { auto_ai_enabled: boolean | null; ai_enabled: boolean } | null;
    return row?.auto_ai_enabled !== false && row?.ai_enabled !== false;
  }

  async getTrackingState(companyId: string, employeeId: string): Promise<{
    trackingPaused: boolean;
    trackingStartAt: string | null;
  } | null> {
    const { data } = await this.supabase
      .from('employees')
      .select('tracking_paused, tracking_start_at')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();
    if (!data) return null;
    return {
      trackingPaused: (data as { tracking_paused: boolean }).tracking_paused,
      trackingStartAt: (data as { tracking_start_at: string | null }).tracking_start_at,
    };
  }

  getSlaHours(employee: Employee, globalDefault = 24): number {
    return employee.slaHoursDefault ?? globalDefault;
  }

  private async getSyncStateRow(employeeId: string) {
    const { data } = await this.supabase
      .from('mail_sync_state')
      .select('last_processed_at, last_gmail_history_id')
      .eq('employee_id', employeeId)
      .maybeSingle();
    return data as { last_processed_at: string | null; last_gmail_history_id: string | null } | null;
  }

  private async upsertMailSyncStart(
    employeeId: string,
    startDateIso: string,
    lastProcessedAt: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.from('mail_sync_state').upsert(
      {
        employee_id: employeeId,
        start_date: startDateIso,
        last_processed_at: lastProcessedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'employee_id' },
    );
    if (error) {
      this.logger.error('Failed to upsert mail_sync_state', error.message);
      throw error;
    }
  }

  private toEmployee(row: EmployeeRow): Employee {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      companyId: row.company_id ?? undefined,
      departmentId: row.department_id ?? undefined,
      role: row.role,
      isActive: row.is_active,
      aiEnabled: row.ai_enabled,
      trackingStartAt: row.tracking_start_at,
      trackingPaused: row.tracking_paused,
      slaHoursDefault: row.sla_hours_default ?? undefined,
      active: row.active,
      autoAiEnabled: row.auto_ai_enabled !== false,
    };
  }
}
