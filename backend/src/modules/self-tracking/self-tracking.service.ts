import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { ConversationsService } from '../conversations/conversations.service';
import { EmployeesService, MailArchiveItem, OrgEmployeeDto } from '../employees/employees.service';
import { RequestContext } from '../common/request-context';
import type { ConversationListItem } from '../dashboard/dashboard.service';

const CEO_SYNCED_MAIL_PAGE_LIMIT = 200;
/** Max calendar span for historical missed search (inclusive). */
const HISTORICAL_MISSED_MAX_RANGE_DAYS = 731;

export interface SelfTrackingDashboard {
  mailboxes: OrgEmployeeDto[];
  needs_attention: ConversationListItem[];
  conversations: ConversationListItem[];
  stats: { total: number; pending: number; missed: number; done: number };
  person_filter_options: { id: string; name: string }[];
  /** Every ingested message from each mailbox's tracking start (paginated slice). */
  synced_mail: {
    total: number;
    items: MailArchiveItem[];
    limit: number;
    offset: number;
  };
}

@Injectable()
export class SelfTrackingService {
  private readonly logger = new Logger(SelfTrackingService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly employeesService: EmployeesService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /**
   * CEO: self-tracked mailboxes (CEO-added) **plus** all TEAM org mailboxes — so manager-connected
   * mail in Employees / manager portal flows into the same CEO My Email dashboard.
   * Sets `is_manager_mailbox` so the UI can show department managers separately from ICs.
   */
  async getVisibleMailboxes(
    ctx: RequestContext,
    callerEmail: string,
  ): Promise<OrgEmployeeDto[]> {
    const selfRows = await this.employeesService.listSelfTracked(ctx.companyId);
    if (ctx.role === 'CEO') {
      const teamRows = await this.employeesService.listTeamMailboxesAcrossCompany(ctx.companyId);
      const byId = new Map<string, OrgEmployeeDto>();
      for (const m of teamRows) byId.set(m.id, m);
      for (const m of selfRows) byId.set(m.id, m);
      const merged = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
      const indicators = await this.employeesService.getManagerMailboxIndicators(ctx.companyId);
      return merged.map((m) => {
        const em = m.email.trim().toLowerCase();
        const is_manager_mailbox =
          indicators.linkedEmployeeIds.has(m.id) || indicators.emailsNormalized.has(em);
        return { ...m, is_manager_mailbox };
      });
    }
    return selfRows.filter((m) => m.email === callerEmail);
  }

  async getDashboard(
    ctx: RequestContext,
    callerEmail: string,
    filters?: {
      status?: string;
      priority?: string;
      mailboxId?: string;
      syncEmployeeIds?: string;
    },
  ): Promise<SelfTrackingDashboard> {
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const emptySynced = {
      total: 0,
      items: [] as MailArchiveItem[],
      limit: CEO_SYNCED_MAIL_PAGE_LIMIT,
      offset: 0,
    };
    if (mailboxes.length === 0) {
      return {
        mailboxes,
        needs_attention: [],
        conversations: [],
        stats: { total: 0, pending: 0, missed: 0, done: 0 },
        person_filter_options: [],
        synced_mail: emptySynced,
      };
    }

    let targetIds = [...new Set(mailboxes.map((m) => m.id).filter((id): id is string => Boolean(id)))];
    if (filters?.mailboxId) {
      if (!targetIds.includes(filters.mailboxId)) {
        throw new ForbiddenException('Mailbox not in your scope');
      }
      targetIds = [filters.mailboxId];
    }

    if (targetIds.length === 0) {
      this.logger.warn('getDashboard: no valid mailbox employee ids; returning empty conversations');
      return {
        mailboxes,
        needs_attention: [],
        conversations: [],
        stats: { total: 0, pending: 0, missed: 0, done: 0 },
        person_filter_options: mailboxes.map((m) => ({ id: m.id, name: m.name })),
        synced_mail: emptySynced,
      };
    }

    let query = this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, company_id, department_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', ctx.companyId)
      .eq('is_ignored', false)
      .in('employee_id', targetIds)
      .order('updated_at', { ascending: false });

    if (filters?.status) query = query.eq('follow_up_status', filters.status);
    if (filters?.priority) query = query.eq('priority', filters.priority);

    const { data, error } = await query;
    if (error) {
      this.logger.error('self-tracking dashboard query', error.message);
      throw new InternalServerErrorException(error.message);
    }

    type Row = {
      conversation_id: string;
      employee_id: string;
      provider_thread_id: string;
      client_name: string | null;
      client_email: string | null;
      follow_up_status: string;
      priority: string;
      delay_hours: number;
      summary: string;
      short_reason: string;
      reason: string;
      last_client_msg_at: string | null;
      last_employee_reply_at: string | null;
      follow_up_required: boolean;
      confidence: number;
      lifecycle_status: string;
      manually_closed: boolean;
      is_ignored: boolean;
      user_cc_only: boolean;
      updated_at: string;
    };

    const rows = (data ?? []) as Row[];
    const nameById = new Map(mailboxes.map((m) => [m.id, m.name]));

    const conversations: ConversationListItem[] = rows.map((r) => {
      const tid = encodeURIComponent(r.provider_thread_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: r.employee_id,
        employee_name: nameById.get(r.employee_id) ?? r.employee_id,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours:
          mailboxes.find((m) => m.id === r.employee_id)?.sla_hours_default ?? 24,
        summary: r.summary,
        short_reason: r.short_reason,
        reason: r.reason || r.short_reason,
        last_client_msg_at: r.last_client_msg_at,
        last_employee_reply_at: r.last_employee_reply_at,
        follow_up_required: r.follow_up_required,
        confidence: r.confidence,
        lifecycle_status: r.lifecycle_status,
        manually_closed: r.manually_closed,
        is_ignored: r.is_ignored,
        user_cc_only: r.user_cc_only ?? false,
        open_gmail_link: `https://mail.google.com/mail/u/0/#inbox/${tid}`,
        updated_at: r.updated_at,
      };
    });

    const needs_attention = conversations.filter(
      (c) =>
        c.follow_up_status === 'MISSED' ||
        (c.priority === 'HIGH' && c.follow_up_status !== 'DONE'),
    );

    const stats = {
      total: conversations.length,
      pending: conversations.filter((c) => c.follow_up_status === 'PENDING')
        .length,
      missed: conversations.filter((c) => c.follow_up_status === 'MISSED')
        .length,
      done: conversations.filter((c) => c.follow_up_status === 'DONE').length,
    };

    let syncedTargetIds = targetIds;
    const rawSync = filters?.syncEmployeeIds?.trim();
    if (rawSync) {
      const requested = [
        ...new Set(
          rawSync
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const allowed = new Set(targetIds);
      const ok = requested.filter((id) => allowed.has(id));
      if (ok.length > 0) syncedTargetIds = ok;
    }

    const trackingStartByEmployee = new Map<string, string | null>();
    for (const m of mailboxes) {
      if (syncedTargetIds.includes(m.id)) {
        trackingStartByEmployee.set(m.id, m.tracking_start_at ?? null);
      }
    }

    const synced = await this.employeesService.listSyncedMailInTrackingWindow(ctx, {
      employeeIds: syncedTargetIds,
      trackingStartByEmployee,
      limit: CEO_SYNCED_MAIL_PAGE_LIMIT,
      offset: 0,
    });

    return {
      mailboxes,
      needs_attention,
      conversations,
      stats,
      person_filter_options: mailboxes.map((m) => ({ id: m.id, name: m.name })),
      synced_mail: {
        total: synced.total,
        items: synced.items,
        limit: CEO_SYNCED_MAIL_PAGE_LIMIT,
        offset: 0,
      },
    };
  }

  /**
   * Past window: threads currently marked MISSED whose last client message falls in [start, end] (ISO timestamps).
   * Same mailbox scope rules as `getDashboard` (`mailbox_id` or comma `employee_ids` subset).
   */
  async getHistoricalMissed(
    ctx: RequestContext,
    callerEmail: string,
    filters: {
      startIso: string;
      endIso: string;
      mailboxId?: string;
      employeeIds?: string;
    },
  ): Promise<{ conversations: ConversationListItem[] }> {
    const startMs = Date.parse(filters.startIso);
    const endMs = Date.parse(filters.endIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new BadRequestException('Invalid start or end date');
    }
    if (endMs < startMs) {
      throw new BadRequestException('End must be on or after start');
    }
    const rangeDays = (endMs - startMs) / 86_400_000;
    if (rangeDays > HISTORICAL_MISSED_MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range cannot exceed ${HISTORICAL_MISSED_MAX_RANGE_DAYS} days`,
      );
    }

    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    if (mailboxes.length === 0) {
      return { conversations: [] };
    }

    let targetIds = [...new Set(mailboxes.map((m) => m.id).filter((id): id is string => Boolean(id)))];
    if (filters.mailboxId) {
      if (!targetIds.includes(filters.mailboxId)) {
        throw new ForbiddenException('Mailbox not in your scope');
      }
      targetIds = [filters.mailboxId];
    }

    const rawEmp = filters.employeeIds?.trim();
    if (rawEmp) {
      const requested = [
        ...new Set(
          rawEmp
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const allowed = new Set(targetIds);
      const ok = requested.filter((id) => allowed.has(id));
      if (ok.length === 0) {
        throw new BadRequestException('No valid employee_ids in your scope');
      }
      targetIds = ok;
    }

    if (targetIds.length === 0) {
      return { conversations: [] };
    }

    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    const { data, error } = await this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, company_id, department_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', ctx.companyId)
      .eq('is_ignored', false)
      .eq('follow_up_status', 'MISSED')
      .in('employee_id', targetIds)
      .not('last_client_msg_at', 'is', null)
      .gte('last_client_msg_at', startIso)
      .lte('last_client_msg_at', endIso)
      .order('last_client_msg_at', { ascending: false });

    if (error) {
      this.logger.error('historical missed query', error.message);
      throw new InternalServerErrorException(error.message);
    }

    type Row = {
      conversation_id: string;
      employee_id: string;
      provider_thread_id: string;
      client_name: string | null;
      client_email: string | null;
      follow_up_status: string;
      priority: string;
      delay_hours: number;
      summary: string;
      short_reason: string;
      reason: string;
      last_client_msg_at: string | null;
      last_employee_reply_at: string | null;
      follow_up_required: boolean;
      confidence: number;
      lifecycle_status: string;
      manually_closed: boolean;
      is_ignored: boolean;
      user_cc_only: boolean;
      updated_at: string;
    };

    const rows = (data ?? []) as Row[];
    const nameById = new Map(mailboxes.map((m) => [m.id, m.name]));

    const conversations: ConversationListItem[] = rows.map((r) => {
      const tid = encodeURIComponent(r.provider_thread_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: r.employee_id,
        employee_name: nameById.get(r.employee_id) ?? r.employee_id,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours:
          mailboxes.find((m) => m.id === r.employee_id)?.sla_hours_default ?? 24,
        summary: r.summary,
        short_reason: r.short_reason,
        reason: r.reason || r.short_reason,
        last_client_msg_at: r.last_client_msg_at,
        last_employee_reply_at: r.last_employee_reply_at,
        follow_up_required: r.follow_up_required,
        confidence: r.confidence,
        lifecycle_status: r.lifecycle_status,
        manually_closed: r.manually_closed,
        is_ignored: r.is_ignored,
        user_cc_only: r.user_cc_only ?? false,
        open_gmail_link: `https://mail.google.com/mail/u/0/#inbox/${tid}`,
        updated_at: r.updated_at,
      };
    });

    return { conversations };
  }

  /**
   * Remove noisy rows already in `email_messages`, record skips, and recompute affected threads (no AI).
   */
  async pruneNoiseMail(
    ctx: RequestContext,
    opts?: { employeeIds?: string[]; maxMessages?: number },
  ): Promise<{
    deleted: number;
    skipsUpserted: number;
    batches: number;
    recompute?: { threadsProcessed: number; created: number; updated: number };
  }> {
    const result = await this.employeesService.pruneNoiseStoredMessages(ctx, opts);
    let recompute: { threadsProcessed: number; created: number; updated: number } | undefined;
    if (result.threadKeys.length > 0) {
      const rc = await this.conversationsService.recomputeForThreads(
        result.threadKeys.map((k) => ({
          companyId: k.companyId,
          employeeId: k.employeeId,
          threadId: k.threadId,
        })),
      );
      recompute = {
        threadsProcessed: rc.threadsProcessed,
        created: rc.created,
        updated: rc.updated,
      };
    }
    return {
      deleted: result.deleted,
      skipsUpserted: result.skipsUpserted,
      batches: result.batches,
      recompute,
    };
  }
}
