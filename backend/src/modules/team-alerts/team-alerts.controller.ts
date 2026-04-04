import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { AuditLogService } from '../common/audit-log.service';
import { TeamAlertsService } from './team-alerts.service';

@Controller('team-alerts')
export class TeamAlertsController {
  constructor(
    private readonly teamAlertsService: TeamAlertsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Literal paths (`send`, `read/:id`) so routing matches reliably (same idea as `portal-password/:id`). */
  @Get('mine')
  async list(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) throw new ForbiddenException();
    return this.teamAlertsService.listForEmployee(ctx);
  }

  @Get('sent')
  async listSent(@Req() req: Request) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) throw new ForbiddenException();
    return this.teamAlertsService.listSentByManager(ctx, user.id);
  }

  @Post('send')
  async send(
    @Req() req: Request,
    @Body() body: { employeeId?: string; message?: string },
  ) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) throw new ForbiddenException();
    const employeeId = body.employeeId?.trim();
    const message = body.message ?? '';
    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }
    const result = await this.teamAlertsService.sendFromManager(ctx, user.id, employeeId, message);
    await this.auditLogService.log({
      userId: user.id,
      companyId: ctx.companyId,
      action: 'team_alert_sent',
      entity: 'employee',
      entityId: employeeId,
    });
    return result;
  }

  @Post('reply')
  async reply(
    @Req() req: Request,
    @Body() body: { parentAlertId?: string; message?: string },
  ) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) throw new ForbiddenException();
    const parentAlertId = body.parentAlertId?.trim();
    const message = body.message ?? '';
    if (!parentAlertId) {
      throw new BadRequestException('parentAlertId is required');
    }
    const result = await this.teamAlertsService.replyFromEmployee(ctx, user.id, parentAlertId, message);
    await this.auditLogService.log({
      userId: user.id,
      companyId: ctx.companyId,
      action: 'team_alert_reply_sent',
      entity: 'team_alert',
      entityId: parentAlertId,
    });
    return result;
  }

  @Patch('read/:id')
  async markRead(@Req() req: Request, @Param('id') id: string) {
    const ctx = getRequestContext(req);
    const user = req.user;
    if (!user) throw new ForbiddenException();
    return this.teamAlertsService.markRead(ctx, id);
  }
}
