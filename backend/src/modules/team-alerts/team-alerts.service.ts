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
import { EmployeesService } from '../employees/employees.service';

export interface TeamAlertDto {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  /** User id of the author of this row (manager for roots; employee for own replies). */
  from_user_id: string;
  from_manager_name: string | null;
  /** Manager login email — optional “Email instead” link in the portal */
  from_manager_email: string | null;
  /** Parent manager message when this row is an employee reply */
  in_reply_to: string | null;
  /** True when this row was written by the signed-in employee (portal user). */
  is_own_message: boolean;
}

export interface TeamAlertSentItem {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  replies: Array<{ id: string; body: string; created_at: string; from_manager: boolean }>;
}

@Injectable()
export class TeamAlertsService {
  private readonly logger = new Logger(TeamAlertsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly employeesService: EmployeesService,
  ) {}

  async sendFromManager(
    ctx: RequestContext,
    fromUserId: string,
    employeeId: string | undefined,
    recipientEmail: string | undefined,
    message: string,
  ) {
    if (ctx.role !== 'HEAD' && ctx.role !== 'CEO') {
      throw new ForbiddenException('Only managers or company admin can send messages');
    }
    if (ctx.role === 'HEAD' && !ctx.departmentId) {
      throw new ForbiddenException('Your manager profile must be assigned to a department');
    }
    const body = message.trim();
    if (!body) {
      throw new BadRequestException('Message is required');
    }
    if (body.length > 4000) {
      throw new BadRequestException('Message must be at most 4000 characters');
    }

    let targetEmployeeId = employeeId?.trim() || null;
    const recipientEmailNorm = recipientEmail?.trim().toLowerCase() || null;
    if (!targetEmployeeId && !recipientEmailNorm) {
      throw new BadRequestException('employeeId or recipientEmail is required');
    }

    if (!targetEmployeeId && recipientEmailNorm) {
      const { data: directRows, error: directErr } = await this.supabase
        .from('employees')
        .select('id')
        .eq('company_id', ctx.companyId)
        .eq('email', recipientEmailNorm)
        .eq('is_active', true)
        .order('roster_duplicate', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(1);
      if (directErr) {
        this.logger.warn(`sendFromManager: recipient lookup by email failed: ${directErr.message}`);
      }
      if ((directRows ?? []).length > 0) {
        targetEmployeeId = (directRows![0] as { id: string }).id;
      } else {
        const { data: managerUser, error: managerErr } = await this.supabase
          .from('users')
          .select('linked_employee_id')
          .eq('company_id', ctx.companyId)
          .eq('email', recipientEmailNorm)
          .eq('role', 'HEAD')
          .maybeSingle();
        if (managerErr) {
          this.logger.warn(`sendFromManager: manager lookup by email failed: ${managerErr.message}`);
        }
        const linkedId =
          (managerUser as { linked_employee_id?: string | null } | null)?.linked_employee_id ?? null;
        if (linkedId) targetEmployeeId = linkedId;
      }
    }

    const { data: emp, error: empErr } = await this.supabase
      .from('employees')
      .select('id, company_id, department_id')
      .eq('id', targetEmployeeId ?? '')
      .maybeSingle();

    if (empErr || !emp) {
      this.logger.warn(
        `sendFromManager: employee not found ${targetEmployeeId ?? recipientEmailNorm ?? ''}: ${empErr?.message}`,
      );
      throw new NotFoundException('Recipient not found');
    }
    if (emp.company_id !== ctx.companyId) {
      throw new ForbiddenException('Team member is outside your company');
    }
    if (ctx.role === 'HEAD' && emp.department_id !== ctx.departmentId) {
      throw new ForbiddenException('You can only alert people in your department');
    }

    const { data: inserted, error: insErr } = await this.supabase
      .from('team_alerts')
      .insert({
        company_id: ctx.companyId,
        employee_id: emp.id,
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

  async replyFromEmployee(ctx: RequestContext, employeeUserId: string, parentAlertId: string, message: string) {
    if ((ctx.role !== 'EMPLOYEE' && !ctx.actAsEmployeePortal) || !ctx.employeeId) {
      throw new ForbiddenException('Only employees can reply from the portal');
    }
    const body = message.trim();
    if (!body) {
      throw new BadRequestException('Message is required');
    }
    if (body.length > 4000) {
      throw new BadRequestException('Message must be at most 4000 characters');
    }

    const { data: parent, error: pErr } = await this.supabase
      .from('team_alerts')
      .select('id, company_id, employee_id, in_reply_to')
      .eq('id', parentAlertId)
      .maybeSingle();

    if (pErr || !parent) {
      throw new NotFoundException('Message not found');
    }

    const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [ctx.employeeId]);

    if (parent.company_id !== ctx.companyId || !expandedIds.includes(parent.employee_id)) {
      throw new ForbiddenException('You can only reply to messages sent to you');
    }
    if (parent.in_reply_to) {
      throw new BadRequestException('You can only reply to a manager message, not to another reply');
    }

    const { data: inserted, error: insErr } = await this.supabase
      .from('team_alerts')
      .insert({
        company_id: ctx.companyId,
        employee_id: parent.employee_id,
        from_user_id: employeeUserId,
        body,
        in_reply_to: parentAlertId,
      })
      .select('id, created_at')
      .maybeSingle();

    if (insErr || !inserted) {
      this.logger.error(`team_alerts reply insert: ${insErr?.message}`);
      throw new BadRequestException('Could not send reply');
    }

    // Treat a reply as addressing the thread: hide the nag banner / "New" row like Dismiss would.
    const now = new Date().toISOString();
    const { error: readErr } = await this.supabase
      .from('team_alerts')
      .update({ read_at: now })
      .eq('id', parentAlertId);
    if (readErr) {
      this.logger.warn(`replyFromEmployee: could not mark parent read ${parentAlertId}: ${readErr.message}`);
    }

    return { ok: true as const, id: inserted.id, created_at: inserted.created_at };
  }

  /** Manager follow-up in an existing thread (same root as employee replies). */
  async replyFromManager(ctx: RequestContext, fromUserId: string, threadRootId: string, message: string) {
    if (ctx.role !== 'HEAD') {
      throw new ForbiddenException('Only department managers can reply here');
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

    const { data: root, error: rErr } = await this.supabase
      .from('team_alerts')
      .select('id, company_id, employee_id, from_user_id, in_reply_to')
      .eq('id', threadRootId)
      .maybeSingle();

    if (rErr || !root) {
      throw new NotFoundException('Thread not found');
    }
    if (root.company_id !== ctx.companyId) {
      throw new ForbiddenException();
    }
    if ((root as { in_reply_to?: string | null }).in_reply_to) {
      throw new BadRequestException('threadRootId must be your original message');
    }
    if (root.from_user_id !== fromUserId) {
      throw new ForbiddenException('You can only reply on threads you started');
    }

    const { data: emp, error: empErr } = await this.supabase
      .from('employees')
      .select('id, department_id')
      .eq('id', root.employee_id as string)
      .maybeSingle();
    if (empErr || !emp) {
      throw new NotFoundException('Team member not found');
    }
    if (emp.department_id !== ctx.departmentId) {
      throw new ForbiddenException('This thread is outside your department');
    }

    const { data: inserted, error: insErr } = await this.supabase
      .from('team_alerts')
      .insert({
        company_id: ctx.companyId,
        employee_id: root.employee_id as string,
        from_user_id: fromUserId,
        body,
        in_reply_to: threadRootId,
      })
      .select('id, created_at')
      .maybeSingle();

    if (insErr || !inserted) {
      this.logger.error(`team_alerts manager reply insert: ${insErr?.message}`);
      throw new BadRequestException('Could not send reply');
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
      .is('in_reply_to', null)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      this.logger.error(`listSentByManager: ${error.message}`);
      throw new BadRequestException('Could not load sent messages');
    }

    const list = rows ?? [];
    const parentIds = list.map((r) => r.id as string);
    const repliesByParent = new Map<
      string,
      Array<{ id: string; body: string; created_at: string; from_manager: boolean }>
    >();
    if (parentIds.length > 0) {
      const { data: replyRows, error: rErr } = await this.supabase
        .from('team_alerts')
        .select('id, body, created_at, in_reply_to, from_user_id')
        .in('in_reply_to', parentIds)
        .order('created_at', { ascending: true });
      if (!rErr && replyRows) {
        for (const rr of replyRows) {
          const pid = rr.in_reply_to as string;
          const arr = repliesByParent.get(pid) ?? [];
          arr.push({
            id: rr.id as string,
            body: rr.body as string,
            created_at: rr.created_at as string,
            from_manager: (rr.from_user_id as string) === fromUserId,
          });
          repliesByParent.set(pid, arr);
        }
      }
    }

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
      const id = r.id as string;
      return {
        id,
        body: r.body as string,
        created_at: r.created_at as string,
        read_at: (r.read_at as string | null) ?? null,
        employee_id: r.employee_id as string,
        employee_name: emp?.name ?? 'Unknown',
        employee_email: emp?.email ?? '',
        replies: repliesByParent.get(id) ?? [],
      };
    });

    return { items };
  }

  async listForEmployee(ctx: RequestContext): Promise<{ items: TeamAlertDto[]; unread_count: number }> {
    if ((ctx.role !== 'EMPLOYEE' && !ctx.actAsEmployeePortal) || !ctx.employeeId) {
      throw new ForbiddenException('Only employees can load their manager alerts here');
    }

    const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [ctx.employeeId]);

    const { data: rows, error } = await this.supabase
      .from('team_alerts')
      .select('id, body, created_at, read_at, from_user_id, in_reply_to')
      .in('employee_id', expandedIds)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      this.logger.error(`listForEmployee: ${error.message}`);
      throw new BadRequestException('Could not load alerts');
    }

    const list = rows ?? [];

    let employeeLinkedUserId: string | null = null;
    const { data: empUserRow } = await this.supabase
      .from('users')
      .select('id')
      .eq('linked_employee_id', ctx.employeeId)
      .maybeSingle();
    if (empUserRow?.id) {
      employeeLinkedUserId = empUserRow.id as string;
    }

    /** Latest employee reply per parent — manager follow-ups do not count as “handled”. */
    const latestReplyAtByParent = new Map<string, string>();
    for (const r of list) {
      const pid = (r as { in_reply_to?: string | null }).in_reply_to;
      if (!pid) continue;
      if (employeeLinkedUserId && (r as { from_user_id: string }).from_user_id !== employeeLinkedUserId) {
        continue;
      }
      const created = r.created_at as string;
      const prev = latestReplyAtByParent.get(pid);
      if (!prev || created > prev) latestReplyAtByParent.set(pid, created);
    }

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
      const uid = r.from_user_id as string;
      const u = userMap.get(uid);
      const replyTo = (r as { in_reply_to?: string | null }).in_reply_to ?? null;
      const id = r.id as string;
      const storedRead = (r.read_at as string | null) ?? null;
      const impliedRead = !replyTo ? latestReplyAtByParent.get(id) : undefined;
      const read_at = storedRead ?? impliedRead ?? null;
      const isOwn = !!(employeeLinkedUserId && uid === employeeLinkedUserId);
      const fromManagerSide = !replyTo || (!isOwn && !!replyTo);
      return {
        id,
        body: r.body as string,
        created_at: r.created_at as string,
        read_at,
        from_user_id: uid,
        from_manager_name: fromManagerSide ? u?.name ?? null : null,
        from_manager_email: fromManagerSide ? u?.email ?? null : null,
        in_reply_to: replyTo,
        is_own_message: isOwn,
      };
    });

    const unread_count = items.filter((i) => !i.read_at && !i.in_reply_to).length;
    return { items, unread_count };
  }

  async markRead(ctx: RequestContext, alertId: string) {
    if ((ctx.role !== 'EMPLOYEE' && !ctx.actAsEmployeePortal) || !ctx.employeeId) {
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

    const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [ctx.employeeId]);

    if (!expandedIds.includes(row.employee_id)) {
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

  /**
   * Employee: any row where employee_id matches (manager message or own reply).
   * Manager: only root messages they sent (deleting parent cascades replies).
   * CEO: any alert in the company.
   */
  async deleteAlert(ctx: RequestContext, userId: string, alertId: string): Promise<void> {
    const { data: row, error: fetchErr } = await this.supabase
      .from('team_alerts')
      .select('id, company_id, employee_id, from_user_id, in_reply_to')
      .eq('id', alertId)
      .maybeSingle();

    if (fetchErr || !row) {
      throw new NotFoundException('Alert not found');
    }
    if (row.company_id !== ctx.companyId) {
      throw new ForbiddenException();
    }

    const inReplyTo = (row as { in_reply_to?: string | null }).in_reply_to ?? null;

    if (ctx.role === 'EMPLOYEE' || ctx.actAsEmployeePortal) {
      if (!ctx.employeeId) {
        throw new ForbiddenException('You can only delete alerts on your own inbox');
      }
      const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [ctx.employeeId]);
      if (!expandedIds.includes(row.employee_id)) {
        throw new ForbiddenException('You can only delete alerts on your own inbox');
      }
    } else if (ctx.role === 'HEAD') {
      if (ctx.actAsEmployeePortal && ctx.employeeId) {
        const { expandedIds } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [ctx.employeeId]);
        if (expandedIds.includes(row.employee_id)) {
          const { error: delErr } = await this.supabase.from('team_alerts').delete().eq('id', alertId);
          if (delErr) {
            this.logger.error(`deleteAlert: ${delErr.message}`);
            throw new BadRequestException('Could not delete alert');
          }
          return;
        }
      }
      if (inReplyTo) {
        throw new BadRequestException('Delete your original message to remove the whole thread');
      }
      if (row.from_user_id !== userId) {
        throw new ForbiddenException('You can only delete messages you sent');
      }
    } else if (ctx.role === 'CEO') {
      /* company scoped above */
    } else {
      throw new ForbiddenException();
    }

    const { error: delErr } = await this.supabase.from('team_alerts').delete().eq('id', alertId);
    if (delErr) {
      this.logger.error(`deleteAlert: ${delErr.message}`);
      throw new BadRequestException('Could not delete alert');
    }
  }
}
