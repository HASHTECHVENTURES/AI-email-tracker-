import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { EmailIngestionService } from '../email-ingestion/email-ingestion.service';
import { Request, Response } from 'express';
import { getRequestContext } from '../common/request-context';
import { EmployeesService } from '../employees/employees.service';
import { SelfTrackingService } from './self-tracking.service';
import { HistoricalFetchService } from './historical-fetch.service';

@Controller('self-tracking')
export class SelfTrackingController {
  constructor(
    private readonly selfTrackingService: SelfTrackingService,
    private readonly employeesService: EmployeesService,
    private readonly historicalFetchService: HistoricalFetchService,
    private readonly emailIngestionService: EmailIngestionService,
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
    /** Comma-separated employee row ids — restrict "synced mail" list to these mailboxes (e.g. CEO tab). */
    @Query('sync_employee_ids') syncEmployeeIds?: string,
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
      syncEmployeeIds,
    });
  }

  /**
   * MISSED threads whose last client message time falls in the given window (ISO `start` / `end`).
   * Optional `employee_ids` (comma-separated) narrows to those mailboxes (must be in CEO scope).
   */
  @Get('historical-missed')
  async historicalMissed(
    @Req() req: Request,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('mailbox_id') mailboxId?: string,
    @Query('employee_ids') employeeIds?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can access self-tracking');
    }
    if (!start?.trim() || !end?.trim()) {
      throw new BadRequestException('start and end query parameters are required');
    }
    return this.selfTrackingService.getHistoricalMissed(ctx, user.email, {
      startIso: start.trim(),
      endIso: end.trim(),
      mailboxId,
      employeeIds,
    });
  }

  /**
   * Read-only: call Gmail `messages.list` with the same query/cursor as live ingestion, and optionally
   * for a historical date window — does not store mail. Use to verify IDs are returned vs DB row counts.
   */
  @Get('mail-fetch-probe')
  async mailFetchProbe(
    @Req() req: Request,
    @Query('employee_id') employeeId: string,
    @Query('historical_start') historicalStart?: string,
    @Query('historical_end') historicalEnd?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can run mail fetch probe');
    }
    const id = employeeId?.trim();
    if (!id) {
      throw new BadRequestException('employee_id is required');
    }

    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(id)) {
      throw new ForbiddenException('Mailbox not in your scope');
    }

    const historicalRange =
      historicalStart?.trim() && historicalEnd?.trim()
        ? { startIso: historicalStart.trim(), endIso: historicalEnd.trim() }
        : undefined;

    return this.emailIngestionService.probeGmailFetch(ctx.companyId, id, {
      maxPages: 5,
      historicalRange,
    });
  }

  /**
   * On-demand historical Gmail fetch: goes to Gmail API, pulls emails in the date range,
   * runs AI classification, stores relevant ones, and returns the resulting conversations.
   */
  @Post('historical-fetch')
  async historicalFetch(
    @Req() req: Request,
    @Body()
    body: {
      start: string;
      end: string;
      employee_id: string;
    },
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can run historical fetch');
    }
    if (!body.start?.trim() || !body.end?.trim()) {
      throw new BadRequestException('start and end are required');
    }
    if (!body.employee_id?.trim()) {
      throw new BadRequestException('employee_id is required');
    }

    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(body.employee_id.trim())) {
      throw new ForbiddenException('Mailbox not in your scope');
    }

    return this.historicalFetchService.fetchHistorical(
      ctx,
      body.employee_id.trim(),
      body.start.trim(),
      body.end.trim(),
    );
  }

  /**
   * Same as historical-fetch but streams SSE progress events for the UI (AI step counts, selections).
   */
  @Post('historical-fetch-stream')
  async historicalFetchStream(
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
    @Body()
    body: {
      start: string;
      end: string;
      employee_id: string;
    },
  ): Promise<void> {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can run historical fetch');
    }
    if (!body.start?.trim() || !body.end?.trim()) {
      throw new BadRequestException('start and end are required');
    }
    if (!body.employee_id?.trim()) {
      throw new BadRequestException('employee_id is required');
    }

    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(body.employee_id.trim())) {
      throw new ForbiddenException('Mailbox not in your scope');
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const write = (payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      await this.historicalFetchService.fetchHistorical(
        ctx,
        body.employee_id.trim(),
        body.start.trim(),
        body.end.trim(),
        write,
      );
    } catch (err) {
      const message =
        err instanceof BadRequestException
          ? String(err.message)
          : (err as Error)?.message ?? 'Historical fetch failed';
      write({ phase: 'error', message });
    }
    res.end();
  }

  /**
   * Legacy endpoint — rule-based prune is disabled; returns a no-op (kept for older clients).
   */
  @Post('prune-noise-mail')
  async pruneNoiseMail(
    @Req() req: Request,
    @Body()
    body?: {
      employee_ids?: string[];
      max_messages?: number;
    },
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    if (ctx.role !== 'CEO') {
      throw new ForbiddenException('Only CEOs can prune synced mail');
    }
    return this.selfTrackingService.pruneNoiseMail(ctx, {
      employeeIds: body?.employee_ids,
      maxMessages: body?.max_messages,
    });
  }
}
