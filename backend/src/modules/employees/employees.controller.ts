import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
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
      throw new UnauthorizedException('User profile not loaded');
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
      throw new UnauthorizedException('User profile not loaded');
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

  /** Manager self-mailbox: create/find tracked mailbox row using signed-in manager email. */
  @Post('my-mailbox')
  async ensureMyMailbox(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException('User profile not loaded');
    }
    return this.employeesService.ensureMyMailbox(ctx, user);
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

  /** CEO: demote a manager to employee under a team; same login email / Supabase Auth user. */
  @Post('convert-manager-to-employee')
  async convertManagerToEmployee(
    @Req() req: Request,
    @Body() body: { email?: string; targetDepartmentId?: string },
  ) {
    const ctx = getRequestContext(req);
    const email = body.email?.trim() ?? '';
    const targetDepartmentId = body.targetDepartmentId?.trim() ?? '';
    if (!email || !targetDepartmentId) {
      throw new BadRequestException('email and targetDepartmentId are required');
    }
    const result = await this.employeesService.convertManagerToEmployee(ctx, {
      email,
      targetDepartmentId,
    });
    await this.auditLogService.log({
      userId: req.user!.id,
      companyId: ctx.companyId,
      action: 'manager_converted_to_employee',
      entity: 'user',
      entityId: result.userId,
    });
    return result;
  }

  /**
   * CEO: keep someone as a department manager (HEAD) and also list them on another team’s roster
   * (same login; secondary row does not receive duplicate mail sync).
   */
  @Post('add-secondary-team-roster')
  async addSecondaryTeamRoster(
    @Req() req: Request,
    @Body() body: { managerEmail?: string; departmentId?: string },
  ) {
    const ctx = getRequestContext(req);
    const managerEmail = body.managerEmail?.trim() ?? '';
    const departmentId = body.departmentId?.trim() ?? '';
    if (!managerEmail || !departmentId) {
      throw new BadRequestException('managerEmail and departmentId are required');
    }
    const created = await this.employeesService.addManagerSecondaryTeamRoster(ctx, {
      managerEmail,
      departmentId,
    });
    await this.auditLogService.log({
      userId: req.user!.id,
      companyId: ctx.companyId,
      action: 'manager_secondary_team_roster_added',
      entity: 'employee',
      entityId: created.id,
    });
    return created;
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
    const updated = await this.employeesService.updateEmployeePauses(
      ctx,
      id,
      body,
      req.user!.email?.trim().toLowerCase() ?? '',
    );
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
    const updated = await this.employeesService.updateEmployeeSla(
      ctx,
      id,
      body.sla_hours,
      req.user!.email?.trim().toLowerCase() ?? '',
    );
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
      req.user!.email?.trim().toLowerCase() ?? '',
    );
    return { ok: true, employee: updated };
  }

  @Patch(':id/tracking-pause')
  async toggleTrackingPause(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { paused?: boolean },
  ) {
    const ctx = getRequestContext(req);
    const paused = body.paused === true;
    await this.employeesService.setTrackingPaused(
      ctx,
      id,
      paused,
      req.user!.email?.trim().toLowerCase() ?? '',
    );
    return { ok: true, paused };
  }

  @Get(':id/messages')
  async getRecentMessages(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const ctx = getRequestContext(req);
    const parsedLimit = Number(limit ?? '10');
    const messages = await this.employeesService.listRecentReceivedMessages(
      ctx,
      id,
      parsedLimit,
      req.user!.email?.trim().toLowerCase() ?? '',
    );
    return { messages };
  }
}
