import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { EmailIngestionService } from '../email-ingestion/email-ingestion.service';
import { Request, Response } from 'express';
import { getRequestContext, type RequestContext } from '../common/request-context';
import { EmployeesService } from '../employees/employees.service';
import { SelfTrackingService } from './self-tracking.service';
import { HistoricalFetchService, type HistoricalProgressFn } from './historical-fetch.service';

/** CEO, department manager (HEAD), and Employee portal — Historical Search + scoped dashboard. */
function assertSelfTrackingReader(ctx: RequestContext): void {
  if (ctx.role !== 'CEO' && ctx.role !== 'HEAD' && ctx.role !== 'EMPLOYEE') {
    throw new ForbiddenException('Only CEO, manager, or employee can access this');
  }
}

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
    assertSelfTrackingReader(ctx);
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
    assertSelfTrackingReader(ctx);
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
    assertSelfTrackingReader(ctx);
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
   * Threads already in the DB for one mailbox whose last client message falls in [start, end] (ISO).
   * Refreshes the Historical Search table after a client-side stop without re-listing Gmail.
   */
  /**
   * Saved Historical Search runs (date range + stats) for mailboxes in scope.
   */
  @Get('historical-search-runs')
  async listHistoricalSearchRuns(@Req() req: Request, @Query('limit') limit?: string) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const n = Number(limit ?? '40');
    const lim = Number.isFinite(n) ? n : 40;
    const runs = await this.selfTrackingService.listHistoricalSearchRuns(ctx, user.email, lim);
    return { runs };
  }

  @Get('historical-search-runs/:id')
  async getHistoricalSearchRun(@Req() req: Request, @Param('id') id: string) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const run = await this.selfTrackingService.getHistoricalSearchRun(ctx, user.email, id);
    if (!run) {
      throw new NotFoundException('Saved search not found');
    }
    return { run };
  }

  @Delete('historical-search-runs/:id')
  async deleteHistoricalSearchRun(@Req() req: Request, @Param('id') id: string) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const { deleted } = await this.selfTrackingService.deleteHistoricalSearchRun(ctx, user.email, id);
    if (!deleted) {
      throw new NotFoundException('Saved search not found');
    }
    return { ok: true };
  }

  /**
   * Messages Gmail sync skipped (Inbox AI not relevant, before tracking start, or legacy id-only rows).
   */
  @Get('ai-skipped-mails')
  async listAiSkippedMails(
    @Req() req: Request,
    @Query('employee_id') employeeId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    /** Optional: restrict to skips whose message time (or skip time if unknown) falls in this window (ISO). */
    @Query('window_start') windowStart?: string,
    @Query('window_end') windowEnd?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const eid = employeeId?.trim();
    if (!eid) {
      throw new BadRequestException('employee_id is required');
    }
    const n = Number(limit ?? '40');
    const o = Number(offset ?? '0');
    const lim = Number.isFinite(n) ? n : 40;
    const off = Number.isFinite(o) ? o : 0;
    const ws = windowStart?.trim();
    const we = windowEnd?.trim();
    const window =
      ws && we
        ? {
            startIso: ws,
            endIso: we,
          }
        : null;
    return this.selfTrackingService.listAiSkippedMails(ctx, user.email, eid, lim, off, window);
  }

  /** Remove one skip so the next sync can re-evaluate that Gmail message. */
  @Delete('ai-skipped-mails')
  async clearAiSkippedMail(
    @Req() req: Request,
    @Query('employee_id') employeeId?: string,
    @Query('provider_message_id') providerMessageId?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const eid = employeeId?.trim();
    const mid = providerMessageId?.trim();
    if (!eid || !mid) {
      throw new BadRequestException('employee_id and provider_message_id are required');
    }
    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(eid)) {
      throw new ForbiddenException('Mailbox not in your scope');
    }
    await this.emailIngestionService.clearIngestionSkipEntry(eid, mid);
    return { ok: true };
  }

  /**
   * Import one AI-skipped message into the portal now (bypasses Inbox AI). Fetches from Gmail, stores, recomputes thread.
   */
  @Post('ai-skipped-mails/import')
  async importAiSkippedMailToPortal(
    @Req() req: Request,
    @Query('employee_id') employeeId?: string,
    @Query('provider_message_id') providerMessageId?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const eid = employeeId?.trim();
    const mid = providerMessageId?.trim();
    if (!eid || !mid) {
      throw new BadRequestException('employee_id and provider_message_id are required');
    }
    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(eid)) {
      throw new ForbiddenException('Mailbox not in your scope');
    }
    return this.emailIngestionService.forceImportSkippedMessage(ctx.companyId, eid, mid);
  }

  @Get('historical-window-results')
  async historicalWindowResults(
    @Req() req: Request,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('employee_id') employeeId?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ctx = getRequestContext(req);
    assertSelfTrackingReader(ctx);
    const s = start?.trim();
    const e = end?.trim();
    const id = employeeId?.trim();
    if (!s || !e || !id) {
      throw new BadRequestException('start, end, and employee_id query parameters are required');
    }
    const mailboxes = await this.selfTrackingService.getVisibleMailboxes(ctx, user.email);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(id)) {
      throw new ForbiddenException('Mailbox not in your scope');
    }
    const { conversations, stats } = await this.selfTrackingService.getHistoricalWindowResultsWithLiveStats(
      ctx,
      user.email,
      id,
      s,
      e,
    );
    return { conversations, stats };
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
    assertSelfTrackingReader(ctx);
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
    assertSelfTrackingReader(ctx);
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
      undefined,
      { createdByUserId: user.id },
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
    assertSelfTrackingReader(ctx);
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
    const emit: HistoricalProgressFn = (e) => {
      try {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
      } catch {
        // Client may have closed the socket (e.g. Stop).
      }
    };

    const ac = new AbortController();
    const onClientClose = () => ac.abort();
    req.on('close', onClientClose);

    try {
      await this.historicalFetchService.fetchHistorical(
        ctx,
        body.employee_id.trim(),
        body.start.trim(),
        body.end.trim(),
        emit,
        { abortSignal: ac.signal, createdByUserId: user.id },
      );
    } catch (err) {
      const message =
        err instanceof BadRequestException
          ? String(err.message)
          : (err as Error)?.message ?? 'Historical fetch failed';
      emit({ phase: 'error', message });
    } finally {
      req.off('close', onClientClose);
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
