import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { getRequestContext } from '../common/request-context';
import { EmployeesService } from '../employees/employees.service';
import { SelfTrackingService } from './self-tracking.service';

@Controller('self-tracking')
export class SelfTrackingController {
  constructor(
    private readonly selfTrackingService: SelfTrackingService,
    private readonly employeesService: EmployeesService,
  ) {}

  @Get('mailboxes')
  async listMailboxes(@Req() req: Request) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can access self-tracking');
    }
    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(
      ctx,
      user.email,
    );
    return { mailboxes };
  }

  @Post('mailboxes')
  async addMailbox(
    @Req() req: Request,
    @Body()
    body: {
      name?: string;
      email?: string;
      departmentId?: string;
      /** Use signed-in CEO name + email — no manual typing for your own inbox. */
      use_my_profile?: boolean | string | number;
    },
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can add self-tracked mailboxes');
    }

    const raw = body as Record<string, unknown>;
    const useMyProfile =
      raw.use_my_profile === true ||
      raw.use_my_profile === 'true' ||
      raw.use_my_profile === 1 ||
      raw.use_my_profile === '1';

    let name = (body.name ?? '').trim();
    let email = (body.email ?? '').trim().toLowerCase();

    if (useMyProfile) {
      const u = (user.email?.trim() || req.jwtEmail?.trim() || '').toLowerCase();
      if (!u) {
        throw new ForbiddenException(
          'Your account has no email on file. Update your profile or sign in again.',
        );
      }
      email = u;
      name =
        user.fullName?.trim() ||
        u.split('@')[0] ||
        'Me';
    }

    const mailbox = await this.employeesService.createSelfTrackedMailbox(
      ctx.companyId,
      user.id,
      {
        name,
        email,
        departmentId: body.departmentId,
      },
    );
    return { mailbox };
  }

  @Delete('mailboxes/:id')
  async removeMailbox(@Req() req: Request, @Param('id') id: string) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can remove self-tracked mailboxes');
    }
    await this.employeesService.deleteSelfTrackedMailbox(ctx.companyId, id);
    return { ok: true };
  }

  @Get('dashboard')
  async dashboard(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('mailbox_id') mailboxId?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can access self-tracking');
    }
    return this.selfTrackingService.getDashboard(ctx, user.email, {
      status,
      priority,
      mailboxId,
    });
  }
}
