import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { DashboardService } from './dashboard.service';
import { EmployeesService } from '../employees/employees.service';

const emptyAiReport = {
  generated_at: null as string | null,
  key_issues: [] as string[],
  employee_insights: [] as string[],
  patterns: [] as string[],
  recommendation: '',
};

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
    return this.dashboardService.getDashboard(
      ctx.companyId,
      {
        departmentId: ctx.role === 'HEAD' ? ctx.departmentId : undefined,
        employeeId: ctx.role === 'EMPLOYEE' ? ctx.employeeId : undefined,
        role: u.role,
      },
      u.role === 'EMPLOYEE'
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
    const conversations = await this.dashboardService.getConversationsList({
      companyId: ctx.companyId,
      departmentId: ctx.role === 'HEAD' ? ctx.departmentId : undefined,
      employeeId: ctx.role === 'EMPLOYEE' ? ctx.employeeId : employeeId,
      status,
      priority,
      lifecycle,
    });

    return {
      total: conversations.length,
      conversations,
    };
  }

  @Get('ai-report')
  async getLastAiReport(@Req() req: Request) {
    const ctx = getRequestContext(req);
    if (ctx.role === 'HEAD') {
      return emptyAiReport;
    }
    const report =
      ctx.role === 'CEO'
        ? await this.dashboardService.getLastAiReport(ctx.companyId, { scope: 'EXECUTIVE' })
        : null;
    return report ?? emptyAiReport;
  }

  @Get('ai-report/generate')
  async generateAiReportNow(@Req() req: Request) {
    const ctx = getRequestContext(req);
    if (ctx.role === 'HEAD') {
      throw new ForbiddenException('Executive AI reports are only available to the CEO.');
    }
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only the CEO can generate AI executive reports.');
    }
    return this.dashboardService.generateAiReport(ctx.companyId, {
      force: true,
      minCooldownMs: 0,
      scope: 'EXECUTIVE',
    });
  }

  @Get('ai-reports')
  async getAiReportArchive(@Req() req: Request, @Query('limit') limit?: string) {
    const ctx = getRequestContext(req);
    const n = Number(limit ?? '50');
    const lim = Number.isFinite(n) ? n : 50;
    if (ctx.role === 'HEAD') {
      return { total: 0, items: [] };
    }
    if (ctx.role === 'CEO') {
      const items = await this.dashboardService.getAiReportArchive(ctx.companyId, lim, { scope: 'EXECUTIVE' });
      return { total: items.length, items };
    }
    return { total: 0, items: [] };
  }

  @Delete('ai-reports/:id')
  async deleteAiReport(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const reportId = id?.trim() ?? '';

    if (ctx.role === 'HEAD') {
      throw new ForbiddenException('Only the CEO can delete executive report archives.');
    }

    if (ctx.role === 'CEO') {
      const ok = await this.dashboardService.deleteExecutiveAiReport(ctx.companyId, reportId);
      if (!ok) {
        throw new NotFoundException('Report not found or you cannot delete it');
      }
      return { ok: true };
    }

    throw new ForbiddenException('You cannot delete this report');
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
