import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { DashboardService } from './dashboard.service';
import { EmployeesService } from '../employees/employees.service';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly employeesService: EmployeesService,
  ) {}

  @Get()
  async getDashboard(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('employee_id') filterEmployeeId?: string,
    /** CEO only — comma-separated employee row ids; scopes KPIs / rollups to those mailboxes (omit = all in view). */
    @Query('employee_ids') filterEmployeeIdsRaw?: string,
    @Query('priority') priority?: string,
    /** CEO only — legacy single department (use `department_ids` for multiple). */
    @Query('department_id') filterDepartmentId?: string,
    /** CEO only — comma-separated department ids; union of teams in KPIs / rollups. */
    @Query('department_ids') filterDepartmentIdsRaw?: string,
  ) {
    const ctx = getRequestContext(req);
    const u = req.user!;
    const ceoDepartmentIds =
      u.role === 'CEO' && filterDepartmentIdsRaw?.trim()
        ? [...new Set(filterDepartmentIdsRaw.split(',').map((s) => s.trim()).filter(Boolean))]
        : undefined;
    const ceoDepartment =
      u.role === 'CEO' && !ceoDepartmentIds?.length && filterDepartmentId?.trim()
        ? filterDepartmentId.trim()
        : undefined;
    const ceoEmployeeIds =
      u.role === 'CEO' && filterEmployeeIdsRaw?.trim()
        ? [...new Set(filterEmployeeIdsRaw.split(',').map((s) => s.trim()).filter(Boolean))]
        : undefined;
    const actAs = ctx.actAsEmployeePortal === true;
    if (u.role === 'HEAD' && !actAs && !ctx.departmentId) {
      throw new ForbiddenException('This manager is not assigned to an active department.');
    }
    const effectiveRole = actAs ? 'EMPLOYEE' : u.role;
    return this.dashboardService.getDashboard(
      ctx.companyId,
      {
        departmentId: actAs || u.role !== 'HEAD' ? undefined : ctx.departmentId,
        employeeId:
          u.role === 'EMPLOYEE' || actAs ? ctx.employeeId : undefined,
        role: effectiveRole,
        userId: u.id,
      },
      actAs || u.role === 'EMPLOYEE'
        ? { status, priority }
        : {
            status,
            employeeId: ceoEmployeeIds?.length ? undefined : filterEmployeeId,
            employeeIds: ceoEmployeeIds?.length ? ceoEmployeeIds : undefined,
            priority,
            departmentId: ceoDepartment,
            departmentIds: ceoDepartmentIds?.length ? ceoDepartmentIds : undefined,
          },
      u.email,
    );
  }

  @Get('metrics')
  async getMetrics(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.dashboardService.getGlobalMetrics(ctx.companyId);
  }

  @Get('employees')
  async getEmployeePerformance(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.dashboardService.getEmployeePerformance(ctx.companyId);
  }

  @Get('conversations')
  async getConversations(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('employee_id') employeeId?: string,
    @Query('priority') priority?: string,
    @Query('lifecycle') lifecycle?: string,
  ) {
    const ctx = getRequestContext(req);
    const actAs = ctx.actAsEmployeePortal === true;
    if (ctx.role === 'HEAD' && !actAs && !ctx.departmentId) {
      throw new ForbiddenException('This manager is not assigned to an active department.');
    }
    const conversations = await this.dashboardService.getConversationsList({
      companyId: ctx.companyId,
      departmentId: actAs || ctx.role !== 'HEAD' ? undefined : ctx.departmentId,
      employeeId:
        ctx.role === 'EMPLOYEE' || actAs ? ctx.employeeId : employeeId,
      status,
      priority,
      lifecycle,
    });

    return {
      total: conversations.length,
      conversations,
    };
  }

  /** Ingested mail archive (same data as legacy GET /employees/mail-archive). */
  @Get('email-archive')
  async emailArchive(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('employee_id') employeeId?: string,
  ) {
    const ctx = getRequestContext(req);
    const l = Number(limit ?? '30');
    const o = Number(offset ?? '0');
    return this.employeesService.listMailArchive(ctx, {
      limit: Number.isFinite(l) ? l : 30,
      offset: Number.isFinite(o) ? o : 0,
      employeeId: employeeId?.trim() || undefined,
    });
  }
}
