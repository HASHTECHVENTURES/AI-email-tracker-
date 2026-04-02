import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { RequestContext } from '../common/request-context';

export interface TeamAlertDto {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  from_manager_name: string | null;
  /** Manager login email — for employee Reply (mailto) in the portal */
  from_manager_email: string | null;
}

export interface TeamAlertSentItem {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  employee_id: string;
  employee_name: string;
  employee_email: string;
}

@Injectable()
export class TeamAlertsService {
  private readonly logger = new Logger(TeamAlertsService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async sendFromManager(ctx: RequestContext, fromUserId: string, employeeId: string, message: string) {
    if (ctx.role !== 'HEAD') {
      throw new ForbiddenException('Only department managers can send alerts to team members');
    }
    if (!ctx.departmentId) {
      throw new ForbiddenException('Your manager profile must be assigned to a department');
    }
    const body = message.trim();
    if (!body) {
      throw new BadRequestException('Message is required');
    }
    if (body.length > 4000) {
      throw new BadRequestException('Message must be at most 4000 characters');
    }

    const { data: emp, error: empErr } = await this.supabase
      .from('employees')
      .select('id, company_id, department_id')
      .eq('id', employeeId)
      .maybeSingle();

    if (empErr || !emp) {
      this.logger.warn(`sendFromManager: employee not found ${employeeId}: ${empErr?.message}`);
      throw new NotFoundException('Team member not found');
    }
    if (emp.company_id !== ctx.companyId) {
      throw new ForbiddenException('Team member is outside your company');
    }
    if (emp.department_id !== ctx.departmentId) {
      throw new ForbiddenException('You can only alert people in your department');
    }

    const { data: inserted, error: insErr } = await this.supabase
      .from('team_alerts')
      .insert({
        company_id: ctx.companyId,
        employee_id: employeeId,
        from_user_id: fromUserId,
        body,
      })
      .select('id, created_at')
      .maybeSingle();

    if (insErr || !inserted) {
      this.logger.error(`team_alerts insert: ${insErr?.message}`);
      throw new BadRequestException('Could not send alert');
    }

    return { ok: true as const, id: inserted.id, created_at: inserted.created_at };
  }

  async listSentByManager(ctx: RequestContext, fromUserId: string): Promise<{ items: TeamAlertSentItem[] }> {
    if (ctx.role !== 'HEAD') {
      throw new ForbiddenException('Only department managers can view sent team messages');
    }

    const { data: rows, error } = await this.supabase
      .from('team_alerts')
      .select('id, body, created_at, read_at, employee_id')
      .eq('from_user_id', fromUserId)
      .eq('company_id', ctx.companyId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      this.logger.error(`listSentByManager: ${error.message}`);
      throw new BadRequestException('Could not load sent messages');
    }

    const list = rows ?? [];
    const empIds = [...new Set(list.map((r) => r.employee_id as string))];
    let empMap = new Map<string, { name: string; email: string }>();
    if (empIds.length > 0) {
      const { data: emps, error: eErr } = await this.supabase
        .from('employees')
        .select('id, name, email')
        .in('id', empIds);
      if (!eErr && emps) {
        empMap = new Map(
          emps.map((e) => [
            e.id as string,
            { name: (e.name as string) ?? 'Unknown', email: (e.email as string) ?? '' },
          ]),
        );
      }
    }

    const items: TeamAlertSentItem[] = list.map((r) => {
      const emp = empMap.get(r.employee_id as string);
      return {
        id: r.id as string,
        body: r.body as string,
        created_at: r.created_at as string,
        read_at: (r.read_at as string | null) ?? null,
        employee_id: r.employee_id as string,
        employee_name: emp?.name ?? 'Unknown',
        employee_email: emp?.email ?? '',
      };
    });

    return { items };
  }

  async listForEmployee(ctx: RequestContext): Promise<{ items: TeamAlertDto[]; unread_count: number }> {
    if (ctx.role !== 'EMPLOYEE' || !ctx.employeeId) {
      throw new ForbiddenException('Only employees can load their manager alerts here');
    }

    const { data: rows, error } = await this.supabase
      .from('team_alerts')
      .select('id, body, created_at, read_at, from_user_id')
      .eq('employee_id', ctx.employeeId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      this.logger.error(`listForEmployee: ${error.message}`);
      throw new BadRequestException('Could not load alerts');
    }

    const list = rows ?? [];
    const userIds = [...new Set(list.map((r) => r.from_user_id as string))];
    let userMap = new Map<string, { name: string | null; email: string | null }>();
    if (userIds.length > 0) {
      const { data: users, error: uErr } = await this.supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', userIds);
      if (!uErr && users) {
        userMap = new Map(
          users.map((u) => [
            u.id as string,
            {
              name: (u.full_name as string | null) ?? null,
              email: (u.email as string | null) ?? null,
            },
          ]),
        );
      }
    }

    const items: TeamAlertDto[] = list.map((r) => {
      const u = userMap.get(r.from_user_id as string);
      return {
        id: r.id as string,
        body: r.body as string,
        created_at: r.created_at as string,
        read_at: (r.read_at as string | null) ?? null,
        from_manager_name: u?.name ?? null,
        from_manager_email: u?.email ?? null,
      };
    });

    const unread_count = items.filter((i) => !i.read_at).length;
    return { items, unread_count };
  }

  async markRead(ctx: RequestContext, alertId: string) {
    if (ctx.role !== 'EMPLOYEE' || !ctx.employeeId) {
      throw new ForbiddenException();
    }

    const { data: row, error: fetchErr } = await this.supabase
      .from('team_alerts')
      .select('id, employee_id')
      .eq('id', alertId)
      .maybeSingle();

    if (fetchErr || !row) {
      throw new NotFoundException('Alert not found');
    }
    if (row.employee_id !== ctx.employeeId) {
      throw new ForbiddenException();
    }

    const now = new Date().toISOString();
    const { error: updErr } = await this.supabase.from('team_alerts').update({ read_at: now }).eq('id', alertId);
    if (updErr) {
      this.logger.error(`markRead: ${updErr.message}`);
      throw new BadRequestException('Could not update alert');
    }
    return { ok: true as const };
  }
}
