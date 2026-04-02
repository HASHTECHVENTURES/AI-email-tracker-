import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { EmployeesService } from './employees.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  async addEmployee(
    @Req() req: Request,
    @Body()
    body: {
      id: string;
      name: string;
      email: string;
      departmentId: string;
      role?: 'CEO' | 'HEAD' | 'EMPLOYEE';
      slaHoursDefault?: number;
      startTrackingAt?: string;
      autoAiEnabled?: boolean;
      trackingPaused?: boolean;
    },
  ) {
    const ctx = getRequestContext(req);
    const employee = await this.employeesService.add({
      id: body.id,
      name: body.name,
      email: body.email,
      companyId: ctx.companyId,
      departmentId: body.departmentId,
      role: body.role,
      slaHoursDefault: body.slaHoursDefault,
      startTrackingAt: body.startTrackingAt,
      autoAiEnabled: body.autoAiEnabled,
      trackingPaused: body.trackingPaused,
    });
    return employee;
  }

  @Get()
  async listActive(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.employeesService.listActiveWithOAuthStatus(ctx.companyId);
  }

  @Patch(':id')
  async updateEmployee(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: {
      autoAiEnabled?: boolean;
      startTrackingAt?: string;
      slaHoursDefault?: number | null;
      trackingPaused?: boolean;
      departmentId?: string;
      role?: 'CEO' | 'HEAD' | 'EMPLOYEE';
    },
  ) {
    const ctx = getRequestContext(req);
    return this.employeesService.updateSettings(ctx.companyId, id, {
      autoAiEnabled: body.autoAiEnabled,
      startTrackingAt: body.startTrackingAt,
      slaHoursDefault: body.slaHoursDefault,
      trackingPaused: body.trackingPaused,
      departmentId: body.departmentId,
      role: body.role,
    });
  }
}
