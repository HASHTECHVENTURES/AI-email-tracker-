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

export interface HistoricalSearchRunListItem {
  id: string;
  employee_id: string;
  mailbox_name: string;
  window_start: string;
  window_end: string;
  created_at: string;
  report_summary: string;
  conversation_count: number;
  stats: Record<string, unknown>;
}

export interface AiSkippedMailItem {
  employee_id: string;
  provider_message_id: string;
  skipped_at: string;
  skip_kind: string;
  skip_reason: string | null;
  subject: string | null;
  from_email: string | null;
  sent_at: string | null;
  provider_thread_id: string | null;
}

function buildHistoricalRunSummary(r: {
  mailbox_name: string;
  window_start: string;
  window_end: string;
  conversation_count: number;
}): string {
  const a = new Date(r.window_start);
  const b = new Date(r.window_end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return `${r.mailbox_name} · ${r.conversation_count} thread(s)`;
  }
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `${r.mailbox_name} · ${fmt(a)} → ${fmt(b)} · ${r.conversation_count} thread(s)`;
}

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
   * HEAD: department TEAM mailboxes **plus** this manager’s own `SELF` rows (Connect my Gmail / any email they add).
   * EMPLOYEE: the single mailbox row linked to the portal login.
   * Sets `is_manager_mailbox` for CEO merged list only.
   */
  async getVisibleMailboxes(
    ctx: RequestContext,
    callerEmail: string,
  ): Promise<OrgEmployeeDto[]> {
    if (ctx.role === 'HEAD') {
      const teamRows = await this.employeesService.listOrgEmployees(ctx);
      const uid = ctx.userId;
      if (!uid) {
        return teamRows;
      }
      const selfRows = await this.employeesService.listSelfTrackedMailboxesForUser(
        ctx.companyId,
        uid,
        callerEmail,
      );
      let linkedRows: OrgEmployeeDto[] = [];
      const { data: linkedProfile } = await this.supabase
        .from('users')
        .select('linked_employee_id')
        .eq('company_id', ctx.companyId)
        .eq('id', uid)
        .maybeSingle();
      let linkedId = (linkedProfile as { linked_employee_id?: string | null } | null)?.linked_employee_id ?? null;
      if (!linkedId) {
        const callerNorm = callerEmail.trim().toLowerCase();
        if (callerNorm.length > 0) {
          const { data: empByEmail } = await this.supabase
            .from('employees')
            .select('id')
            .eq('company_id', ctx.companyId)
            .eq('is_active', true)
            .eq('email', callerNorm)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          linkedId = (empByEmail as { id?: string } | null)?.id ?? null;
        }
      }
      if (linkedId) {
        linkedRows = await this.employeesService.getLinkedPortalEmployeeMailbox({
          ...ctx,
          role: 'EMPLOYEE',
          employeeId: linkedId,
        });
      }
      const byId = new Map<string, OrgEmployeeDto>();
      for (const m of teamRows) byId.set(m.id, m);
      for (const m of selfRows) byId.set(m.id, m);
      for (const m of linkedRows) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (ctx.role === 'EMPLOYEE') {
      return this.employeesService.getLinkedPortalEmployeeMailbox(ctx);
    }

    const selfRows = await this.employeesService.listSelfTracked(ctx.companyId);
    if (ctx.role === 'CEO') {
      await this.employeesService.ensureDepartmentManagerMailboxes(ctx.companyId);
      const teamRows = await this.employeesService.listTeamMailboxesAcrossCompany(ctx.companyId);
      const byId = new Map<string, OrgEmployeeDto>();
      for (const m of teamRows) byId.set(m.id, m);
      for (const m of selfRows) byId.set(m.id, m);
      const merged = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
      const indicators = await this.employeesService.getManagerMailboxIndicators(ctx.companyId);
      return merged.map((m) => {
        const createdBy = m.created_by ?? null;
        const emailNorm = m.email.trim().toLowerCase();
        const rosterDup = m.roster_duplicate === true;
        const linked = indicators.linkedEmployeeIds.has(m.id);
        const emailMatchesHead =
          emailNorm.length > 0 && indicators.emailsNormalized.has(emailNorm);
        /**
         * Canonical manager inbox for CEO Manager mail — not `roster_duplicate` directory rows
         * (same HEAD may also appear on another team’s roster as an employee under someone else).
         */
        const is_manager_mailbox =
          linked ||
          (m.mailbox_type === 'SELF' &&
            createdBy != null &&
            indicators.headUserIds.has(createdBy)) ||
          (emailMatchesHead && !rosterDup);
        return { ...m, is_manager_mailbox };
      });
    }
    const callerNorm = callerEmail.trim().toLowerCase();
    return selfRows.filter((m) => m.email.trim().toLowerCase() === callerNorm);
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

    const { expandedIds, aliasToTargetMap } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, targetIds);

    let query = this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, company_id, department_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', ctx.companyId)
      .eq('is_ignored', false)
      .in('employee_id', expandedIds)
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

    const trackingStartMsByEmployee = new Map<string, number>();
    for (const m of mailboxes) {
      const raw = m.tracking_start_at;
      if (raw && !Number.isNaN(Date.parse(raw))) {
        trackingStartMsByEmployee.set(m.id, Date.parse(raw));
      }
    }

    const conversations: ConversationListItem[] = rows
      .filter((r) => {
        const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
        const t0 = trackingStartMsByEmployee.get(targetId);
        if (t0 == null) return true;
        if (!r.last_client_msg_at) return false;
        return Date.parse(r.last_client_msg_at) >= t0;
      })
      .map((r) => {
        const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
        const tid = encodeURIComponent(r.provider_thread_id);
        return {
          conversation_id: r.conversation_id,
          employee_id: targetId,
          employee_name: nameById.get(targetId) ?? targetId,
          provider_thread_id: r.provider_thread_id,
          client_name: r.client_name,
          client_email: r.client_email,
          follow_up_status: r.follow_up_status,
          priority: r.priority,
          delay_hours: r.delay_hours,
          sla_hours:
            mailboxes.find((m) => m.id === targetId)?.sla_hours_default ?? 24,
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

    const syncAliasMap = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, syncedTargetIds);
    
    // trackingStartByEmployee should be propagated to aliases
    const expandedTrackingDocs = new Map<string, string | null>();
    for (const id of syncAliasMap.expandedIds) {
      const targetId = syncAliasMap.aliasToTargetMap.get(id) ?? id;
      expandedTrackingDocs.set(id, trackingStartByEmployee.get(targetId) ?? null);
    }

    const synced = await this.employeesService.listSyncedMailInTrackingWindow(ctx, {
      employeeIds: syncAliasMap.expandedIds,
      trackingStartByEmployee: expandedTrackingDocs,
      limit: CEO_SYNCED_MAIL_PAGE_LIMIT,
      offset: 0,
    });

    
    // Remap synced mail employee ids and names
    for (const item of synced.items) {
      const targetId = syncAliasMap.aliasToTargetMap.get(item.employee_id) ?? item.employee_id;
      item.employee_id = targetId;
      item.employee_name = nameById.get(targetId) ?? item.employee_name;
    }

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

    const { expandedIds, aliasToTargetMap } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, targetIds);

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
      .in('employee_id', expandedIds)
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
      const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
      const tid = encodeURIComponent(r.provider_thread_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: targetId,
        employee_name: nameById.get(targetId) ?? targetId,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours:
          mailboxes.find((m) => m.id === targetId)?.sla_hours_default ?? 24,
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
   * All follow-up rows for one mailbox whose **last client message** time falls in `[startIso, endIso]`
   * (any status). Used by Historical Search so the table shows threads that Live sync already ingested —
   * not only threads touched by a one-off Gmail pull in that run.
   */
  async listConversationsByLastClientMsgWindow(
    ctx: RequestContext,
    employeeId: string,
    employeeName: string,
    startIso: string,
    endIso: string,
  ): Promise<ConversationListItem[]> {
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
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

    const { data: empRow } = await this.supabase
      .from('employees')
      .select('sla_hours_default')
      .eq('id', employeeId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    const slaHours =
      (empRow as { sla_hours_default: number | null } | null)?.sla_hours_default ?? 24;

    const startBound = new Date(startMs).toISOString();
    const endBound = new Date(endMs).toISOString();

    const { expandedIds, aliasToTargetMap } = await this.employeesService.getEmployeeAliasMapping(ctx.companyId, [employeeId]);

    const { data, error } = await this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', ctx.companyId)
      .in('employee_id', expandedIds)
      .eq('is_ignored', false)
      .not('last_client_msg_at', 'is', null)
      .gte('last_client_msg_at', startBound)
      .lte('last_client_msg_at', endBound)
      .order('last_client_msg_at', { ascending: false });

    if (error) {
      this.logger.error('listConversationsByLastClientMsgWindow', error.message);
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

    return (data ?? []).map((r: Row) => {
      const targetId = aliasToTargetMap.get(r.employee_id) ?? r.employee_id;
      const tid = encodeURIComponent(r.provider_thread_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: targetId,
        employee_name: employeeName,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours: slaHours,
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

  /**
   * Persist one Historical Search completion (Gmail window + stats) for My Email + dashboard recall.
   */
  async recordHistoricalSearchRun(
    ctx: RequestContext,
    params: {
      createdByUserId: string;
      employeeId: string;
      mailboxName: string;
      startIso: string;
      endIso: string;
      stats: Record<string, unknown>;
      conversationCount: number;
    },
  ): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('historical_search_runs')
      .insert({
        company_id: ctx.companyId,
        created_by_user_id: params.createdByUserId,
        employee_id: params.employeeId,
        mailbox_name: params.mailboxName.slice(0, 500),
        window_start: params.startIso,
        window_end: params.endIso,
        stats: params.stats,
        conversation_count: params.conversationCount,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      this.logger.warn(`recordHistoricalSearchRun: ${error.message}`);
      return null;
    }
    const row = data as { id?: string } | null;
    return row?.id ?? null;
  }

  /**
   * Saved Historical Search runs the caller can see (mailbox must be in {@link getVisibleMailboxes} scope).
   */
  async listHistoricalSearchRuns(
    ctx: RequestContext,
    callerEmail: string,
    limit = 40,
  ): Promise<HistoricalSearchRunListItem[]> {
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const ids = [...new Set(mailboxes.map((m) => m.id))];
    if (ids.length === 0) return [];
    const lim = Math.min(Math.max(1, limit), 100);
    const { data, error } = await this.supabase
      .from('historical_search_runs')
      .select('id, employee_id, mailbox_name, window_start, window_end, created_at, stats, conversation_count')
      .eq('company_id', ctx.companyId)
      .in('employee_id', ids)
      .order('created_at', { ascending: false })
      .limit(lim);
    if (error) {
      this.logger.warn(`listHistoricalSearchRuns: ${error.message}`);
      return [];
    }
    const rows = (data ?? []) as Array<{
      id: string;
      employee_id: string;
      mailbox_name: string;
      window_start: string;
      window_end: string;
      created_at: string;
      stats: Record<string, unknown> | null;
      conversation_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      employee_id: r.employee_id,
      mailbox_name: r.mailbox_name,
      window_start: r.window_start,
      window_end: r.window_end,
      created_at: r.created_at,
      conversation_count: r.conversation_count,
      stats: (r.stats ?? {}) as Record<string, unknown>,
      report_summary: buildHistoricalRunSummary(r),
    }));
  }

  async getHistoricalSearchRun(
    ctx: RequestContext,
    callerEmail: string,
    runId: string,
  ): Promise<HistoricalSearchRunListItem | null> {
    const id = runId?.trim();
    if (!id) return null;
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const allowed = new Set(mailboxes.map((m) => m.id));
    const { data, error } = await this.supabase
      .from('historical_search_runs')
      .select('id, employee_id, mailbox_name, window_start, window_end, created_at, stats, conversation_count')
      .eq('company_id', ctx.companyId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      this.logger.warn(`getHistoricalSearchRun: ${error.message}`);
      return null;
    }
    const r = data as {
      id: string;
      employee_id: string;
      mailbox_name: string;
      window_start: string;
      window_end: string;
      created_at: string;
      stats: Record<string, unknown> | null;
      conversation_count: number;
    } | null;
    if (!r || !allowed.has(r.employee_id)) return null;
    return {
      id: r.id,
      employee_id: r.employee_id,
      mailbox_name: r.mailbox_name,
      window_start: r.window_start,
      window_end: r.window_end,
      created_at: r.created_at,
      conversation_count: r.conversation_count,
      stats: (r.stats ?? {}) as Record<string, unknown>,
      report_summary: buildHistoricalRunSummary(r),
    };
  }

  async deleteHistoricalSearchRun(
    ctx: RequestContext,
    callerEmail: string,
    runId: string,
  ): Promise<{ deleted: boolean }> {
    const id = runId?.trim();
    if (!id) return { deleted: false };
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const allowed = new Set(mailboxes.map((m) => m.id));
    const { data: row, error: loadErr } = await this.supabase
      .from('historical_search_runs')
      .select('id, employee_id')
      .eq('company_id', ctx.companyId)
      .eq('id', id)
      .maybeSingle();
    if (loadErr) {
      this.logger.warn(`deleteHistoricalSearchRun load: ${loadErr.message}`);
      throw new InternalServerErrorException(loadErr.message);
    }
    const r = row as { id: string; employee_id: string } | null;
    if (!r || !allowed.has(r.employee_id)) {
      return { deleted: false };
    }
    const { error: delErr } = await this.supabase
      .from('historical_search_runs')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('id', id);
    if (delErr) {
      this.logger.warn(`deleteHistoricalSearchRun: ${delErr.message}`);
      throw new InternalServerErrorException(delErr.message);
    }
    return { deleted: true };
  }

  /**
   * Recent ingestion skips for one mailbox (AI “not relevant”, before tracking window, etc.).
   * Requires mailbox in {@link getVisibleMailboxes} scope.
   */
  async listAiSkippedMails(
    ctx: RequestContext,
    callerEmail: string,
    employeeId: string,
    limit = 40,
    offset = 0,
    window?: { startIso: string; endIso: string } | null,
  ): Promise<{ total: number; items: AiSkippedMailItem[] }> {
    const id = employeeId?.trim();
    if (!id) {
      throw new BadRequestException('employee_id is required');
    }
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const allowed = new Set(mailboxes.map((m) => m.id));
    if (!allowed.has(id)) {
      throw new ForbiddenException('Mailbox not in your scope');
    }
    const lim = Math.min(Math.max(1, limit), 100);
    const off = Math.max(0, offset);

    const mapRow = (r: {
      employee_id: string;
      provider_message_id: string;
      skipped_at: string;
      skip_kind: string | null;
      skip_reason: string | null;
      subject: string | null;
      from_email: string | null;
      sent_at: string | null;
      provider_thread_id: string | null;
    }): AiSkippedMailItem => ({
      employee_id: r.employee_id,
      provider_message_id: r.provider_message_id,
      skipped_at: r.skipped_at,
      skip_kind: r.skip_kind ?? 'legacy',
      skip_reason: r.skip_reason,
      subject: r.subject,
      from_email: r.from_email,
      sent_at: r.sent_at,
      provider_thread_id: r.provider_thread_id,
    });

    const win = window?.startIso?.trim() && window?.endIso?.trim()
      ? { start: window.startIso.trim(), end: window.endIso.trim() }
      : null;

    /** Historical Search window: merge rows with sent_at in range and rows with null sent_at but skipped_at in range. */
    if (win) {
      const MAX_FETCH = 4000;
      const sel =
        'employee_id, provider_message_id, skipped_at, skip_kind, skip_reason, subject, from_email, sent_at, provider_thread_id';

      const { data: withSent, error: e1 } = await this.supabase
        .from('email_ingestion_skips')
        .select(sel)
        .eq('employee_id', id)
        .not('sent_at', 'is', null)
        .gte('sent_at', win.start)
        .lte('sent_at', win.end)
        .order('skipped_at', { ascending: false })
        .limit(MAX_FETCH);

      const { data: noSent, error: e2 } = await this.supabase
        .from('email_ingestion_skips')
        .select(sel)
        .eq('employee_id', id)
        .is('sent_at', null)
        .gte('skipped_at', win.start)
        .lte('skipped_at', win.end)
        .order('skipped_at', { ascending: false })
        .limit(MAX_FETCH);

      if (e1) {
        this.logger.warn(`listAiSkippedMails (window sent_at): ${e1.message}`);
        throw new InternalServerErrorException(e1.message);
      }
      if (e2) {
        this.logger.warn(`listAiSkippedMails (window skipped_at): ${e2.message}`);
        throw new InternalServerErrorException(e2.message);
      }

      type Row = Parameters<typeof mapRow>[0];
      const byMsg = new Map<string, Row>();
      for (const r of [...(withSent ?? []), ...(noSent ?? [])] as Row[]) {
        byMsg.set(r.provider_message_id, r);
      }
      const merged = [...byMsg.values()].sort(
        (a, b) => new Date(b.skipped_at).getTime() - new Date(a.skipped_at).getTime(),
      );
      const total = merged.length;
      const slice = merged.slice(off, off + lim);
      return {
        total,
        items: slice.map(mapRow),
      };
    }

    const { count, error: cErr } = await this.supabase
      .from('email_ingestion_skips')
      .select('provider_message_id', { count: 'exact', head: true })
      .eq('employee_id', id);
    if (cErr) {
      this.logger.warn(`listAiSkippedMails count: ${cErr.message}`);
      throw new InternalServerErrorException(cErr.message);
    }

    const { data, error } = await this.supabase
      .from('email_ingestion_skips')
      .select(
        'employee_id, provider_message_id, skipped_at, skip_kind, skip_reason, subject, from_email, sent_at, provider_thread_id',
      )
      .eq('employee_id', id)
      .order('skipped_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) {
      this.logger.warn(`listAiSkippedMails: ${error.message}`);
      throw new InternalServerErrorException(error.message);
    }

    const rows = (data ?? []) as Array<Parameters<typeof mapRow>[0]>;

    return {
      total: count ?? rows.length,
      items: rows.map(mapRow),
    };
  }

  /**
   * Historical Search table + stat cards from current DB state (stays in sync after thread deletes / skip clears).
   */
  async getHistoricalWindowResultsWithLiveStats(
    ctx: RequestContext,
    callerEmail: string,
    employeeId: string,
    startIso: string,
    endIso: string,
  ): Promise<{
    conversations: ConversationListItem[];
    stats: {
      fetched_from_gmail: number;
      stored_relevant: number;
      skipped_irrelevant: number;
      conversations_created: number;
    };
  }> {
    const s = startIso.trim();
    const e = endIso.trim();
    const mailboxes = await this.getVisibleMailboxes(ctx, callerEmail);
    const name = mailboxes.find((m) => m.id === employeeId)?.name ?? 'Mailbox';
    const conversations = await this.listConversationsByLastClientMsgWindow(ctx, employeeId, name, s, e);
    const skipRes = await this.listAiSkippedMails(ctx, callerEmail, employeeId, 1, 0, {
      startIso: s,
      endIso: e,
    });
    const empty = conversations.length === 0 && skipRes.total === 0;
    if (empty) {
      return {
        conversations,
        stats: {
          fetched_from_gmail: 0,
          stored_relevant: 0,
          skipped_irrelevant: 0,
          conversations_created: 0,
        },
      };
    }
    const runStats = await this.getLatestHistoricalRunStatsForWindow(ctx.companyId, employeeId, s, e);
    const rawFetched = runStats['fetched_from_gmail'];
    const fetched =
      typeof rawFetched === 'number'
        ? rawFetched
        : typeof rawFetched === 'string'
          ? Number(rawFetched) || 0
          : 0;
    return {
      conversations,
      stats: {
        fetched_from_gmail: fetched,
        stored_relevant: conversations.length,
        skipped_irrelevant: skipRes.total,
        conversations_created: conversations.length,
      },
    };
  }

  private async getLatestHistoricalRunStatsForWindow(
    companyId: string,
    employeeId: string,
    startIso: string,
    endIso: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.supabase
      .from('historical_search_runs')
      .select('stats')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .eq('window_start', startIso)
      .eq('window_end', endIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      this.logger.warn(`getLatestHistoricalRunStatsForWindow: ${error.message}`);
      return {};
    }
    const row = data as { stats?: Record<string, unknown> } | null;
    return (row?.stats ?? {}) as Record<string, unknown>;
  }
}
