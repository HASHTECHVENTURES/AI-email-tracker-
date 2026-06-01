import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { FollowUpStatus } from '../common/types';
import { EmployeesService } from '../employees/employees.service';
import { FollowupService } from '../followup/followup.service';
import { AiEnrichmentService } from '../ai-enrichment/ai-enrichment.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { EmailService } from '../email/email.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import { isMigration026ColumnError, stripConversations026Fields } from '../common/migration-026-compat';
import {
  looksLikeInboundNoReplyNoise,
  looksLikeMeetingOrEventMail,
  looksLikeConversationClosure,
  looksLikeShortAcknowledgment,
} from '../email-ingestion/relevance-guards';

/** Skip-ledger marker so Gmail sync does not recreate a user-resolved thread. */
export const USER_RESOLVED_THREAD_SKIP_PREFIX = '__user_resolved_thread__:';

export function userResolvedThreadSkipMessageId(providerThreadId: string): string {
  return `${USER_RESOLVED_THREAD_SKIP_PREFIX}${providerThreadId}`;
}

interface ThreadKey {
  companyId?: string;
  employeeId: string;
  threadId: string;
}

interface EmailRow {
  provider_message_id: string;
  provider_thread_id: string;
  employee_id: string;
  direction: string;
  from_email: string;
  from_name: string | null;
  reply_to_email: string | null;
  to_emails: string[];
  cc_emails: string[] | null;
  subject: string;
  body_text: string | null;
  sent_at: string;
}

interface ConversationRow {
  conversation_id: string;
  provider_thread_id: string;
  employee_id: string;
  company_id: string;
  department_id: string | null;
  client_name: string | null;
  client_email: string | null;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  follow_up_required: boolean;
  follow_up_status: string;
  delay_hours: number;
  priority: string;
  summary: string;
  confidence: number;
  lifecycle_status: string;
  short_reason: string;
  reason: string;
  manually_closed: boolean;
  is_ignored: boolean;
  user_cc_only: boolean;
  updated_at: string;
}

export interface RecomputeResult {
  threadsProcessed: number;
  created: number;
  updated: number;
  aiEnriched: number;
  statusBreakdown: Record<FollowUpStatus, number>;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly followupService: FollowupService,
    private readonly employeesService: EmployeesService,
    private readonly aiEnrichmentService: AiEnrichmentService,
    private readonly alertsService: AlertsService,
    private readonly settingsService: SettingsService,
    private readonly emailService: EmailService,
    private readonly companyPolicyService: CompanyPolicyService,
  ) {}

  async recomputeForThreads(threadKeys: ThreadKey[]): Promise<RecomputeResult> {
    const globalSla = await this.settingsService.getDefaultSlaHours();
    const settings = await this.settingsService.getAll();
    const companyAiAllowed = new Map<string, boolean>();
    const result: RecomputeResult = {
      threadsProcessed: 0,
      created: 0,
      updated: 0,
      aiEnriched: 0,
      statusBreakdown: { DONE: 0, PENDING: 0, MISSED: 0 },
    };

    for (const key of threadKeys) {
      const outcome = await this.recomputeThread(
        key.companyId,
        key.employeeId,
        key.threadId,
        globalSla,
        settings.ai_enabled,
        companyAiAllowed,
      );
      result.threadsProcessed++;
      if (outcome.action === 'created') result.created++;
      if (outcome.action === 'updated') result.updated++;
      if (outcome.enriched) result.aiEnriched++;
    }

    const counts = await this.getStatusCounts();
    result.statusBreakdown = counts;
    return result;
  }

  async recomputeAllForCompany(companyId: string): Promise<RecomputeResult> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('employee_id, provider_thread_id')
      .eq('company_id', companyId)
      .eq('is_ignored', false);

    if (error) {
      this.logger.error('recomputeAllForCompany: query failed', error.message);
      throw error;
    }

    const keys: ThreadKey[] = (data ?? []).map(
      (r: { employee_id: string; provider_thread_id: string }) => ({
        companyId,
        employeeId: r.employee_id,
        threadId: r.provider_thread_id,
      }),
    );

    this.logger.log(`recomputeAllForCompany: ${keys.length} threads`);
    return this.recomputeForThreads(keys);
  }

  async recomputeRecent(): Promise<RecomputeResult> {
    const threadKeys = await this.findStaleThreads();
    this.logger.log(`Found ${threadKeys.length} threads needing recompute`);
    return this.recomputeForThreads(threadKeys);
  }

  async getAll(filters: { companyId: string; employeeId?: string; departmentId?: string }): Promise<ConversationRow[]> {
    let query = this.supabase
      .from('conversations')
      .select('*')
      .eq('company_id', filters.companyId)
      .eq('is_ignored', false)
      .order('updated_at', { ascending: false });

    if (filters.departmentId) query = query.eq('department_id', filters.departmentId);
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId);

    const { data, error } = await query;
    if (error) {
      this.logger.error('Failed to fetch conversations', error.message);
      throw error;
    }
    return data as ConversationRow[];
  }

  /**
   * Resolve = permanently remove thread data from Supabase (messages + conversation row)
   * and record a tiny skip marker so sync does not recreate it.
   */
  async markAsDone(companyId: string, conversationId: string): Promise<boolean> {
    const conversation = await this.getConversation(companyId, conversationId);
    if (!conversation) return false;
    await this.permanentlyRemoveConversation(companyId, conversationId);
    return true;
  }

  /** True when the user clicked Resolve on this Gmail thread (skip marker in ingestion ledger). */
  async isThreadPermanentlyResolved(employeeId: string, providerThreadId: string): Promise<boolean> {
    const markerId = userResolvedThreadSkipMessageId(providerThreadId);
    const { data, error } = await this.supabase
      .from('email_ingestion_skips')
      .select('provider_message_id')
      .eq('employee_id', employeeId)
      .eq('provider_message_id', markerId)
      .maybeSingle();
    if (error) {
      this.logger.warn(`isThreadPermanentlyResolved: ${error.message}`);
      return false;
    }
    return data != null;
  }

  private async recordUserResolvedThreadSkip(
    employeeId: string,
    providerThreadId: string,
  ): Promise<void> {
    const row: Record<string, unknown> = {
      employee_id: employeeId,
      provider_message_id: userResolvedThreadSkipMessageId(providerThreadId),
      skip_kind: 'legacy',
      skip_reason: 'User resolved — thread permanently removed from portal.',
      provider_thread_id: providerThreadId,
      skipped_at: new Date().toISOString(),
      classification_status: 'skipped',
    };
    let { error } = await this.supabase.from('email_ingestion_skips').upsert(row, {
      onConflict: 'employee_id,provider_message_id',
    });
    if (error && isMigration026ColumnError(error)) {
      const legacy: Record<string, unknown> = {
        employee_id: employeeId,
        provider_message_id: row.provider_message_id,
        skipped_at: row.skipped_at,
      };
      ({ error } = await this.supabase.from('email_ingestion_skips').upsert(legacy, {
        onConflict: 'employee_id,provider_message_id',
      }));
    }
    if (error) {
      this.logger.error(`recordUserResolvedThreadSkip ${providerThreadId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deletes conversation row, all ingested message bodies for the thread, related alerts,
   * and per-thread skip rows; leaves one small skip marker to block re-ingest.
   */
  async permanentlyRemoveConversation(companyId: string, conversationId: string): Promise<void> {
    const conversation = await this.getConversation(companyId, conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const { employee_id: employeeId, provider_thread_id: providerThreadId } = conversation;

    const { error: alertsError } = await this.supabase
      .from('alerts')
      .delete()
      .eq('conversation_id', conversationId);
    if (alertsError) {
      this.logger.warn(`permanentlyRemoveConversation alerts ${conversationId}: ${alertsError.message}`);
    }

    const { error: msgError } = await this.supabase
      .from('email_messages')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .eq('provider_thread_id', providerThreadId);

    if (msgError) {
      this.logger.error(`Failed to delete messages for ${conversationId}`, msgError.message);
      throw msgError;
    }

    const { error: skipThreadError } = await this.supabase
      .from('email_ingestion_skips')
      .delete()
      .eq('employee_id', employeeId)
      .eq('provider_thread_id', providerThreadId);
    if (skipThreadError) {
      const { error: skipLegacy } = await this.supabase
        .from('email_ingestion_skips')
        .delete()
        .eq('employee_id', employeeId)
        .like('provider_message_id', `${USER_RESOLVED_THREAD_SKIP_PREFIX}%`);
      if (skipLegacy) {
        this.logger.warn(
          `permanentlyRemoveConversation skips ${conversationId}: ${skipThreadError.message}`,
        );
      }
    }

    await this.recordUserResolvedThreadSkip(employeeId, providerThreadId);

    const { error: convError } = await this.supabase
      .from('conversations')
      .delete()
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId);

    if (convError) {
      this.logger.error(`Failed to delete conversation ${conversationId}`, convError.message);
      throw convError;
    }

    this.logger.log(
      `Permanently removed conversation ${conversationId} (messages + row; thread marked resolved)`,
    );
  }

  async ignoreThread(companyId: string, conversationId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('conversations')
      .update({
        is_ignored: true,
        lifecycle_status: 'ARCHIVED',
        short_reason: 'Ignored by user.',
        reason: 'Thread ignored — excluded from follow-up monitoring.',
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId)
      .select('conversation_id');

    if (error) {
      this.logger.error(`Failed to ignore ${conversationId}`, error.message);
      throw error;
    }
    return (data?.length ?? 0) > 0;
  }

  async deleteConversation(companyId: string, conversationId: string): Promise<void> {
    await this.permanentlyRemoveConversation(companyId, conversationId);
  }

  /**
   * Remove threads that were "resolved" with the old mark-done flow (row kept in DB).
   * Permanently deletes messages + conversation and records skip markers.
   */
  async purgeLegacyManuallyResolvedThreads(
    companyId: string,
    opts?: { employeeIds?: string[]; limit?: number },
  ): Promise<{ removed: number; failed: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    let query = this.supabase
      .from('conversations')
      .select('conversation_id, manually_closed, reason, short_reason')
      .eq('company_id', companyId);

    if (opts?.employeeIds?.length) {
      query = query.in('employee_id', opts.employeeIds);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error('purgeLegacyManuallyResolvedThreads list failed', error.message);
      throw error;
    }

    const legacy = (data ?? []).filter((r) => {
      const row = r as {
        conversation_id: string;
        manually_closed?: boolean;
        reason?: string | null;
        short_reason?: string | null;
      };
      if (row.manually_closed === true) return true;
      const reason = (row.reason ?? '').toLowerCase();
      const short = (row.short_reason ?? '').toLowerCase();
      return (
        reason.includes('manually marked') ||
        reason.includes('marked done by user') ||
        short.includes('manually marked')
      );
    });

    let removed = 0;
    let failed = 0;
    for (const row of legacy.slice(0, limit)) {
      try {
        await this.permanentlyRemoveConversation(companyId, row.conversation_id);
        removed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(
          `purgeLegacyManuallyResolvedThreads failed ${row.conversation_id}: ${(e as Error).message}`,
        );
      }
    }
    if (removed > 0) {
      this.logger.log(
        `purgeLegacyManuallyResolvedThreads: removed ${removed} legacy resolved thread(s) (failed=${failed})`,
      );
    }
    return { removed, failed };
  }

  /**
   * Reassign a conversation thread to a different employee in the same company.
   *
   * Because `conversation_id` is the composite key `{employee_id}:{provider_thread_id}`,
   * reassignment requires:
   *   1. Migrating email_messages rows to the target employee.
   *   2. Inserting a new conversation record for the target employee.
   *   3. Deleting the old conversation record.
   *
   * Returns the new `conversation_id`.
   */
  async reassignConversation(
    companyId: string,
    conversationId: string,
    targetEmployeeId: string,
  ): Promise<{ newConversationId: string }> {
    const old = await this.getConversation(companyId, conversationId);
    if (!old) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (old.employee_id === targetEmployeeId) {
      return { newConversationId: conversationId };
    }

    const targetEmployee = await this.employeesService.getById(companyId, targetEmployeeId);
    if (!targetEmployee) {
      throw new Error(`Target employee ${targetEmployeeId} not found in this company`);
    }

    const newConversationId = `${targetEmployeeId}:${old.provider_thread_id}`;

    // 1. Migrate email_messages to the target employee
    const { error: msgErr } = await this.supabase
      .from('email_messages')
      .update({ employee_id: targetEmployeeId })
      .eq('company_id', companyId)
      .eq('employee_id', old.employee_id)
      .eq('provider_thread_id', old.provider_thread_id);

    if (msgErr) {
      this.logger.error(`Failed to migrate email_messages for reassign ${conversationId}`, msgErr.message);
      throw msgErr;
    }

    // 2. Insert the new conversation record (clone + update identity fields)
    const newRow = {
      conversation_id: newConversationId,
      provider_thread_id: old.provider_thread_id,
      employee_id: targetEmployeeId,
      company_id: companyId,
      department_id: targetEmployee.departmentId ?? null,
      client_name: old.client_name,
      client_email: old.client_email,
      last_client_msg_at: old.last_client_msg_at,
      last_employee_reply_at: old.last_employee_reply_at,
      follow_up_required: old.follow_up_required,
      follow_up_status: old.follow_up_status,
      delay_hours: old.delay_hours,
      priority: old.priority,
      summary: old.summary,
      confidence: old.confidence,
      lifecycle_status: old.lifecycle_status,
      short_reason: old.short_reason,
      reason: old.reason,
      manually_closed: old.manually_closed,
      is_ignored: old.is_ignored,
      user_cc_only: old.user_cc_only ?? false,
      updated_at: new Date().toISOString(),
    };

    const { error: insertErr } = await this.supabase
      .from('conversations')
      .upsert(newRow, { onConflict: 'conversation_id' });

    if (insertErr) {
      // Rollback email_messages migration
      await this.supabase
        .from('email_messages')
        .update({ employee_id: old.employee_id })
        .eq('company_id', companyId)
        .eq('employee_id', targetEmployeeId)
        .eq('provider_thread_id', old.provider_thread_id);
      this.logger.error(`Failed to insert reassigned conversation ${newConversationId}`, insertErr.message);
      throw insertErr;
    }

    // 3. Delete the old conversation record
    const { error: delErr } = await this.supabase
      .from('conversations')
      .delete()
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId);

    if (delErr) {
      this.logger.error(`Failed to delete old conversation ${conversationId} after reassign`, delErr.message);
      // Non-fatal — the new record exists; old one is orphaned but has no email messages
    }

    this.logger.log(`Reassigned ${conversationId} → ${newConversationId} (employee: ${old.employee_id} → ${targetEmployeeId})`);
    return { newConversationId };
  }

  async autoArchiveResolved(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .from('conversations')
      .update({ lifecycle_status: 'ARCHIVED', updated_at: new Date().toISOString() })
      .eq('lifecycle_status', 'RESOLVED')
      .lt('updated_at', sevenDaysAgo)
      .select('conversation_id');

    if (error) {
      this.logger.error('Auto-archive failed', error.message);
      return 0;
    }
    const count = data?.length ?? 0;
    if (count > 0) this.logger.log(`Auto-archived ${count} resolved conversations`);
    return count;
  }

  private async recomputeThread(
    companyId: string | undefined,
    employeeId: string,
    threadId: string,
    globalSlaHours: number,
    settingsAiEnabled: boolean,
    companyAiAllowed: Map<string, boolean>,
  ): Promise<{ action: 'created' | 'updated'; enriched: boolean }> {
    if (!companyId) return { action: 'updated', enriched: false };
    const employee = await this.employeesService.getById(companyId, employeeId);
    if (!employee) {
      this.logger.warn(`Employee ${employeeId} not found, skipping thread ${threadId}`);
      return { action: 'updated', enriched: false };
    }

    const { data: emails, error } = await this.supabase
      .from('email_messages')
      .select(
        'provider_message_id, provider_thread_id, employee_id, direction, from_email, from_name, reply_to_email, to_emails, cc_emails, subject, body_text, sent_at',
      )
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .eq('provider_thread_id', threadId)
      .order('sent_at', { ascending: true });

    if (error || !emails || emails.length === 0) {
      return { action: 'updated', enriched: false };
    }

    const rows = emails as EmailRow[];
    const inbound = rows.filter((r) => r.direction === 'INBOUND');
    const outbound = rows.filter((r) => r.direction === 'OUTBOUND');

    const lastInbound = inbound.length ? inbound[inbound.length - 1] : null;
    const lastOutbound = outbound.length ? outbound[outbound.length - 1] : null;

    const lastClientMsgAt = lastInbound ? new Date(lastInbound.sent_at) : null;
    const lastEmployeeReplyAt = lastOutbound ? new Date(lastOutbound.sent_at) : null;

    const userCcOnly = lastInbound
      ? ConversationsService.mailboxIsCcOnlyOnLatestInbound(employee.email, lastInbound.to_emails, lastInbound.cc_emails)
      : false;

    const slaHours = this.employeesService.getSlaHours(employee, globalSlaHours);
    const existing = await this.getConversation(companyId, `${employeeId}:${threadId}`);

    const manuallyClosed = existing?.manually_closed ?? false;
    const isIgnored = existing?.is_ignored ?? false;

    // If ignored, don't recompute
    if (isIgnored) {
      return { action: 'updated', enriched: false };
    }

    const result = this.followupService.analyze(lastClientMsgAt, lastEmployeeReplyAt, slaHours, manuallyClosed);

    const inboundFields = lastInbound
      ? { direction: 'INBOUND' as const, from_email: lastInbound.from_email, subject: lastInbound.subject, body_text: lastInbound.body_text }
      : null;

    const latestInboundIsCalendar = inboundFields
      ? looksLikeMeetingOrEventMail(inboundFields)
      : false;

    const latestInboundIsNoise = inboundFields
      ? looksLikeInboundNoReplyNoise(inboundFields) && !latestInboundIsCalendar
      : false;

    const latestInboundIsClosure = inboundFields
      ? looksLikeConversationClosure(inboundFields) ||
        (lastEmployeeReplyAt !== null &&
          lastClientMsgAt !== null &&
          lastClientMsgAt > lastEmployeeReplyAt &&
          looksLikeShortAcknowledgment(inboundFields))
      : false;

    const contactEmail = (
      lastInbound?.reply_to_email?.trim() ||
      lastInbound?.from_email?.trim() ||
      null
    );
    const contactName = (lastInbound?.from_name ?? '').trim() || contactEmail;
    const conversationId = `${employeeId}:${threadId}`;

    const senderLocal = (contactEmail ?? '').split('@')[0]?.toLowerCase() ?? '';
    const looksAutomated =
      /^(no-?reply|noreply|notifications?|mailer-daemon|bounce|donotreply|automated|system|support\+?|notify|alerts?|updates?-noreply|billing|invoices?|receipts?|orders?|payments?|accounts?|marketing|newsletter|webmaster|postmaster)$/i.test(senderLocal);

    /** Latest non-empty inbound subject so the UI shows a real thread title when AI summary is still empty. */
    const inboundSubjectLine =
      [...inbound]
        .reverse()
        .map((m) => (m.subject ?? '').trim())
        .find((s) => s.length > 0) ?? '';

    const existingSummary = (existing?.summary ?? '').trim();
    const summaryForRow =
      existingSummary.length >= 12
        ? existingSummary
        : inboundSubjectLine || existingSummary;

    const row = {
      conversation_id: conversationId,
      provider_thread_id: threadId,
      employee_id: employeeId,
      company_id: companyId,
      department_id: employee.departmentId ?? null,
      client_name: contactName,
      client_email: contactEmail,
      last_client_msg_at: lastClientMsgAt?.toISOString() ?? null,
      last_employee_reply_at: lastEmployeeReplyAt?.toISOString() ?? null,
      follow_up_required:
        userCcOnly || latestInboundIsNoise || latestInboundIsCalendar || latestInboundIsClosure ? false : result.followUpRequired,
      follow_up_status:
        userCcOnly || latestInboundIsNoise || latestInboundIsCalendar || latestInboundIsClosure ? 'DONE' : result.followUpStatus,
      delay_hours: result.delayHours,
      lifecycle_status:
        userCcOnly || latestInboundIsNoise || latestInboundIsCalendar || latestInboundIsClosure ? 'RESOLVED' : result.lifecycleStatus,
      short_reason: latestInboundIsClosure
        ? 'Client indicated the conversation is closed — no reply needed.'
        : latestInboundIsCalendar
          ? 'Calendar/meeting invite — no reply needed.'
          : latestInboundIsNoise
            ? 'Promotional mail — no reply needed.'
            : result.shortReason,
      reason: latestInboundIsClosure
        ? 'Client indicated the conversation is closed — no reply needed.'
        : latestInboundIsCalendar
          ? 'Calendar/meeting invite — no reply needed.'
          : latestInboundIsNoise
            ? 'Promotional mail — no reply needed.'
            : result.shortReason,
      manually_closed: manuallyClosed,
      is_ignored: isIgnored,
      user_cc_only: userCcOnly,
      priority: looksAutomated || latestInboundIsNoise || latestInboundIsClosure ? 'LOW' : latestInboundIsCalendar ? (existing?.priority ?? 'LOW') : (existing?.priority ?? 'MEDIUM'),
      summary: summaryForRow,
      confidence: existing ? Number(existing.confidence) : 0,
      classification_status: 'classified',
      ai_confidence_score: existing ? Number(existing.confidence) : 0,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await this.supabase
      .from('conversations')
      .upsert(row, { onConflict: 'conversation_id' });

    let upsertFinal = upsertError;
    if (upsertError && isMigration026ColumnError(upsertError)) {
      const legacy = stripConversations026Fields(row);
      const { error: retryErr } = await this.supabase
        .from('conversations')
        .upsert(legacy, { onConflict: 'conversation_id' });
      upsertFinal = retryErr;
      if (!retryErr) {
        this.logger.warn(
          `Upsert ${conversationId}: retried without migration 026 columns (apply 026 for classification_status / ai_confidence_score).`,
        );
      }
    }

    if (upsertFinal) {
      this.logger.error(`Failed to upsert conversation ${conversationId}`, upsertFinal.message);
      throw upsertFinal;
    }

    const oldFollowUpStatus = (existing?.follow_up_status as FollowUpStatus | undefined) ?? null;
    await this.alertsService.notifyPendingToMissedIfNeeded({
      companyId,
      conversationId,
      employeeId,
      oldStatus: oldFollowUpStatus,
      newStatus: result.followUpStatus,
      employeeName: employee.name,
      employeeEmail: employee.email,
      clientEmail: contactEmail,
      delayHours: result.delayHours,
      slaHours,
      shortReason: result.shortReason,
    });

    if (
      result.followUpStatus === 'PENDING' &&
      row.priority === 'HIGH' &&
      result.delayHours > slaHours
    ) {
      void this.emailService.maybeSendMissedAlert(companyId, {
        employee: employee.name,
        hours: result.delayHours,
        status: 'HIGH priority SLA',
        client_email: contactEmail ?? '',
      }, conversationId);
    }

    let enriched = false;
    let platformAiEnabled = companyAiAllowed.get(companyId);
    if (platformAiEnabled === undefined) {
      platformAiEnabled = await this.companyPolicyService.isAiEnabledForCompany(companyId);
      companyAiAllowed.set(companyId, platformAiEnabled);
    }
    if (settingsAiEnabled && platformAiEnabled && this.aiEnrichmentService.isAvailable) {
      try {
        const out = await this.aiEnrichmentService.enrichConversation(conversationId, employeeId, threadId);
        enriched = out !== null;
      } catch (err) {
        this.logger.warn(`AI enrichment failed for ${conversationId}: ${(err as Error).message}`);
      }
    }

    return { action: existing ? 'updated' : 'created', enriched };
  }

  private async getConversation(companyId: string, conversationId: string): Promise<ConversationRow | null> {
    const { data } = await this.supabase
      .from('conversations')
      .select('*')
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    return data as ConversationRow | null;
  }

  /** Returns the department_id of an employee within a company, or null if not found. */
  async getEmployeeDepartment(companyId: string, employeeId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('employees')
      .select('department_id')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle();
    return (data as { department_id: string | null } | null)?.department_id ?? null;
  }

  /** Labels + Gmail link for the thread read page (no PII beyond what the row already stores). */
  async getPortalThreadContext(
    companyId: string,
    conversationId: string,
  ): Promise<{
    conv: ConversationRow;
    employee_name: string;
    open_gmail_link: string;
  } | null> {
    const conv = await this.getConversation(companyId, conversationId);
    if (!conv) return null;
    const { data: emp } = await this.supabase
      .from('employees')
      .select('name')
      .eq('company_id', companyId)
      .eq('id', conv.employee_id)
      .maybeSingle();
    const tid = encodeURIComponent(conv.provider_thread_id);
    const employee_name = (emp as { name: string } | null)?.name?.trim() || conv.employee_id;
    const open_gmail_link = `https://mail.google.com/mail/u/0/#inbox/${tid}`;
    return { conv, employee_name, open_gmail_link };
  }

  async getConversationScopeRow(companyId: string, conversationId: string): Promise<{
    company_id: string;
    employee_id: string;
    department_id: string | null;
  } | null> {
    const { data } = await this.supabase
      .from('conversations')
      .select('company_id, employee_id, department_id')
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    return (data ?? null) as { company_id: string; employee_id: string; department_id: string | null } | null;
  }

  /**
   * All ingested messages for a thread, oldest first — `body_text` is the full plain-text body from Gmail ingestion
   * (HTML parts converted to text), up to an ingestion storage cap.
   */
  async listIngestedThreadMessages(
    companyId: string,
    conversationId: string,
  ): Promise<
    Array<{
      provider_message_id: string;
      subject: string;
      from_email: string;
      from_name: string | null;
      to_emails: string[];
      direction: string;
      body_text: string;
      sent_at: string;
    }>
  > {
    const conv = await this.getConversation(companyId, conversationId);
    if (!conv) {
      return [];
    }
    const { data, error } = await this.supabase
      .from('email_messages')
      .select(
        'provider_message_id, subject, from_email, from_name, to_emails, direction, body_text, sent_at',
      )
      .eq('company_id', companyId)
      .eq('employee_id', conv.employee_id)
      .eq('provider_thread_id', conv.provider_thread_id)
      .order('sent_at', { ascending: true });
    if (error) {
      this.logger.error(`listIngestedThreadMessages: ${error.message}`);
      throw new InternalServerErrorException('Could not load thread messages');
    }
    return (data ?? []) as Array<{
      provider_message_id: string;
      subject: string;
      from_email: string;
      from_name: string | null;
      to_emails: string[];
      direction: string;
      body_text: string;
      sent_at: string;
    }>;
  }

  private async findStaleThreads(): Promise<ThreadKey[]> {
    const { data, error } = await this.supabase.rpc('find_stale_threads');

    if (!error && data) {
      return (data as { employee_id: string; provider_thread_id: string; company_id?: string }[]).map((r) => ({
        companyId: r.company_id,
        employeeId: r.employee_id,
        threadId: r.provider_thread_id,
      }));
    }

    const { data: allThreads, error: fallbackError } = await this.supabase
      .from('email_messages')
      .select('employee_id, provider_thread_id, company_id');

    if (fallbackError || !allThreads) {
      this.logger.error('Failed to find stale threads', fallbackError?.message);
      return [];
    }

    const uniqueKeys = new Map<string, ThreadKey>();
    for (const row of allThreads as { employee_id: string; provider_thread_id: string; company_id: string }[]) {
      const key = `${row.employee_id}:${row.provider_thread_id}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.set(key, { companyId: row.company_id, employeeId: row.employee_id, threadId: row.provider_thread_id });
      }
    }

    const stale: ThreadKey[] = [];
    for (const tk of uniqueKeys.values()) {
      const convId = `${tk.employeeId}:${tk.threadId}`;
      const { data: conv } = await this.supabase
        .from('conversations')
        .select('updated_at')
        .eq('conversation_id', convId)
        .maybeSingle();

      if (!conv) {
        stale.push(tk);
        continue;
      }

      const { data: newerEmail } = await this.supabase
        .from('email_messages')
        .select('ingested_at')
        .eq('employee_id', tk.employeeId)
        .eq('provider_thread_id', tk.threadId)
        .gt('ingested_at', (conv as { updated_at: string }).updated_at)
        .limit(1)
        .maybeSingle();

      if (newerEmail) {
        stale.push(tk);
      }
    }

    return stale;
  }

  private async getStatusCounts(): Promise<Record<FollowUpStatus, number>> {
    const result: Record<FollowUpStatus, number> = { DONE: 0, PENDING: 0, MISSED: 0 };

    for (const status of ['DONE', 'PENDING', 'MISSED'] as FollowUpStatus[]) {
      const { count } = await this.supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('follow_up_status', status)
        .eq('is_ignored', false);

      result[status] = count ?? 0;
    }

    return result;
  }

  /**
   * Attach the latest non-empty Gmail subject per thread (original subject line for UI tables).
   */
  async attachThreadSubjects<T extends { employee_id: string; provider_thread_id: string }>(
    items: T[],
  ): Promise<(T & { thread_subject: string | null })[]> {
    if (items.length === 0) return [];
    const employeeIds = [...new Set(items.map((i) => i.employee_id))];
    const threadIds = [...new Set(items.map((i) => i.provider_thread_id))];
    const { data, error } = await this.supabase
      .from('email_messages')
      .select('employee_id, provider_thread_id, subject, sent_at')
      .in('employee_id', employeeIds)
      .in('provider_thread_id', threadIds)
      .order('sent_at', { ascending: false })
      .limit(Math.min(10_000, items.length * 20));
    if (error) {
      this.logger.warn(`attachThreadSubjects: ${error.message}`);
      return items.map((i) => ({ ...i, thread_subject: null }));
    }
    const subjectByKey = new Map<string, string>();
    for (const row of data ?? []) {
      const key = `${row.employee_id}:${row.provider_thread_id}`;
      if (subjectByKey.has(key)) continue;
      const sub = (row.subject as string | null)?.trim() ?? '';
      if (sub.length > 0) subjectByKey.set(key, sub);
    }
    return items.map((i) => ({
      ...i,
      thread_subject: subjectByKey.get(`${i.employee_id}:${i.provider_thread_id}`) ?? null,
    }));
  }

  /** Latest inbound: in To → primary; only in Cc → FYI bucket in UI. */
  private static mailboxIsCcOnlyOnLatestInbound(
    mailboxEmail: string,
    toEmails: string[] | null | undefined,
    ccEmails: string[] | null | undefined,
  ): boolean {
    const m = mailboxEmail.trim().toLowerCase();
    if (!m) return false;
    const inTo = (toEmails ?? []).some((e) => e.trim().toLowerCase() === m);
    if (inTo) return false;
    const inCc = (ccEmails ?? []).some((e) => e.trim().toLowerCase() === m);
    return inCc;
  }
}
