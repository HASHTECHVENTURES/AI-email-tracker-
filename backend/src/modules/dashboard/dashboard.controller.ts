import { Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  async getDashboard(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.dashboardService.getDashboard(ctx.companyId, {
      departmentId: ctx.role === 'HEAD' ? ctx.departmentId : undefined,
      employeeId: ctx.role === 'EMPLOYEE' ? ctx.employeeId : undefined,
    });
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

  @Post('ai-report')
  async generateAiReport(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.dashboardService.generateAiReport(ctx.companyId, true);
  }

  @Get('ai-report')
  async getLastAiReport(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const report = await this.dashboardService.getLastAiReport(ctx.companyId);
    return report ?? { generated_at: null, key_issues: [], employee_insights: [], patterns: [], recommendation: '' };
  }
}
