import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Patch,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { EmployeesService } from './employees.service';
import { AuditLogService } from '../common/audit-log.service';

@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      name?: string;
      email?: string;
      departmentId?: string;
      /** Manager-chosen password for Employee portal (email + password login) */
      password?: string;
    },
  ) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) {
      throw new ForbiddenException();
    }
    if (!body.name?.trim() || !body.email?.trim() || !body.departmentId || !body.password?.trim()) {
      throw new BadRequestException(
        'name, email, departmentId, and password are required (manager sets the team member login)',
      );
    }
    const created = await this.employeesService.createOrgEmployee(ctx, user.id, {
      name: body.name,
      email: body.email,
      departmentId: body.departmentId,
      password: body.password,
    });
    await this.auditLogService.log({
      userId: user.id,
      companyId: ctx.companyId,
      action: 'employee_added',
      entity: 'employee',
      entityId: created.id,
    });
    return created;
  }

  /** Path is `portal-password/:id` so routing matches reliably (avoid `:id/portal-password` 404 on some setups). */
  @Patch('portal-password/:id')
  async setEmployeePortalPassword(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) {
      throw new ForbiddenException();
    }
    const password = body.password?.trim() ?? '';
    if (!password) {
      throw new BadRequestException('password is required (min 8 characters)');
    }
    const result = await this.employeesService.setOrProvisionEmployeePortalPassword(ctx, id, password);
    await this.auditLogService.log({
      userId: user.id,
      companyId: ctx.companyId,
      action: 'employee_portal_password_set',
      entity: 'employee',
      entityId: id,
    });
    return result;
  }

  @Get()
  async list(@Req() req: Request) {
    const ctx = getRequestContext(req);
    return this.employeesService.listOrgEmployees(ctx);
  }

  @Get('mail-archive')
  async mailArchive(
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

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    await this.employeesService.deleteOrgEmployee(ctx, id);
    return { status: 'ok' };
  }

  /** Per-employee: pause Gmail fetch (`tracking_paused`) and/or AI (`ai_enabled`). CEO or department HEAD only. */
  @Patch(':id/pauses')
  async updatePauses(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { tracking_paused?: boolean; ai_enabled?: boolean },
  ) {
    const ctx = getRequestContext(req);
    const updated = await this.employeesService.updateEmployeePauses(ctx, id, body);
    await this.auditLogService.log({
      userId: req.user!.id,
      companyId: ctx.companyId,
      action: 'employee_pauses_updated',
      entity: 'employee',
      entityId: id,
    });
    return { ok: true, employee: updated };
  }

  @Patch(':id/sla')
  async updateSla(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { sla_hours?: number },
  ) {
    const ctx = getRequestContext(req);
    if (typeof body.sla_hours !== 'number') {
      throw new BadRequestException('sla_hours is required');
    }
    const updated = await this.employeesService.updateEmployeeSla(ctx, id, body.sla_hours);
    return { ok: true, employee: updated };
  }

  @Patch(':id/tracking-start')
  async updateTrackingStart(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { tracking_start_at?: string },
  ) {
    const ctx = getRequestContext(req);
    if (!body.tracking_start_at?.trim()) {
      throw new BadRequestException('tracking_start_at is required');
    }
    const updated = await this.employeesService.updateEmployeeTrackingStart(
      ctx,
      id,
      body.tracking_start_at.trim(),
    );
    return { ok: true, employee: updated };
  }

  @Get(':id/messages')
  async getRecentMessages(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const ctx = getRequestContext(req);
    const parsedLimit = Number(limit ?? '10');
    const messages = await this.employeesService.listRecentReceivedMessages(ctx, id, parsedLimit);
    return { messages };
  }
}
