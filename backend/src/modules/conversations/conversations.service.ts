import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { FollowUpStatus } from '../common/types';
import { EmployeesService } from '../employees/employees.service';
import { FollowupService } from '../followup/followup.service';
import { AiEnrichmentService } from '../ai-enrichment/ai-enrichment.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { EmailService } from '../email/email.service';

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
  to_emails: string[];
  subject: string;
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
  ) {}

  async recomputeForThreads(threadKeys: ThreadKey[]): Promise<RecomputeResult> {
    const globalSla = await this.settingsService.getDefaultSlaHours();
    const result: RecomputeResult = {
      threadsProcessed: 0,
      created: 0,
      updated: 0,
      aiEnriched: 0,
      statusBreakdown: { DONE: 0, PENDING: 0, MISSED: 0 },
    };

    for (const key of threadKeys) {
      const outcome = await this.recomputeThread(key.companyId, key.employeeId, key.threadId, globalSla);
      result.threadsProcessed++;
      if (outcome.action === 'created') result.created++;
      if (outcome.action === 'updated') result.updated++;
      if (outcome.enriched) result.aiEnriched++;
    }

    const counts = await this.getStatusCounts();
    result.statusBreakdown = counts;
    return result;
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

  async markAsDone(companyId: string, conversationId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('conversations')
      .update({
        manually_closed: true,
        follow_up_status: 'DONE',
        lifecycle_status: 'RESOLVED',
        short_reason: 'Manually marked as done.',
        reason: 'Marked done by user. No follow-up required for this thread.',
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId)
      .select('conversation_id');

    if (error) {
      this.logger.error(`Failed to mark ${conversationId} as done`, error.message);
      throw error;
    }
    return (data?.length ?? 0) > 0;
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
    // Derive employee_id and provider_thread_id from the composite key
    const conversation = await this.getConversation(companyId, conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Delete all email messages in this thread for this employee first
    const { error: msgError } = await this.supabase
      .from('email_messages')
      .delete()
      .eq('company_id', companyId)
      .eq('employee_id', conversation.employee_id)
      .eq('provider_thread_id', conversation.provider_thread_id);

    if (msgError) {
      this.logger.error(`Failed to delete messages for ${conversationId}`, msgError.message);
      throw msgError;
    }

    // Delete the conversation record
    const { error: convError } = await this.supabase
      .from('conversations')
      .delete()
      .eq('company_id', companyId)
      .eq('conversation_id', conversationId);

    if (convError) {
      this.logger.error(`Failed to delete conversation ${conversationId}`, convError.message);
      throw convError;
    }

    this.logger.log(`Permanently deleted conversation ${conversationId} and its messages`);
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
  ): Promise<{ action: 'created' | 'updated'; enriched: boolean }> {
    if (!companyId) return { action: 'updated', enriched: false };
    const employee = await this.employeesService.getById(companyId, employeeId);
    if (!employee) {
      this.logger.warn(`Employee ${employeeId} not found, skipping thread ${threadId}`);
      return { action: 'updated', enriched: false };
    }

    const { data: emails, error } = await this.supabase
      .from('email_messages')
      .select('provider_message_id, provider_thread_id, employee_id, direction, from_email, to_emails, subject, sent_at')
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

    const slaHours = this.employeesService.getSlaHours(employee, globalSlaHours);
    const existing = await this.getConversation(companyId, `${employeeId}:${threadId}`);

    const manuallyClosed = existing?.manually_closed ?? false;
    const isIgnored = existing?.is_ignored ?? false;

    // If ignored, don't recompute
    if (isIgnored) {
      return { action: 'updated', enriched: false };
    }

    const result = this.followupService.analyze(lastClientMsgAt, lastEmployeeReplyAt, slaHours, manuallyClosed);

    const clientEmail = lastInbound?.from_email ?? null;
    const conversationId = `${employeeId}:${threadId}`;

    const row = {
      conversation_id: conversationId,
      provider_thread_id: threadId,
      employee_id: employeeId,
      company_id: companyId,
      department_id: employee.departmentId ?? null,
      client_name: clientEmail,
      client_email: clientEmail,
      last_client_msg_at: lastClientMsgAt?.toISOString() ?? null,
      last_employee_reply_at: lastEmployeeReplyAt?.toISOString() ?? null,
      follow_up_required: result.followUpRequired,
      follow_up_status: result.followUpStatus,
      delay_hours: result.delayHours,
      lifecycle_status: result.lifecycleStatus,
      short_reason: result.shortReason,
      reason: result.shortReason,
      manually_closed: manuallyClosed,
      is_ignored: isIgnored,
      priority: existing?.priority ?? 'MEDIUM',
      summary: existing?.summary ?? '',
      confidence: existing ? Number(existing.confidence) : 0,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await this.supabase
      .from('conversations')
      .upsert(row, { onConflict: 'conversation_id' });

    if (upsertError) {
      this.logger.error(`Failed to upsert conversation ${conversationId}`, upsertError.message);
      throw upsertError;
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
      clientEmail: clientEmail,
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
        client_email: clientEmail ?? '',
      }, conversationId);
    }

    // AI enrichment: global + CEO role/mailbox-type toggles + per-mailbox
    let enriched = false;
    const settings = await this.settingsService.getAll();
    const aiEnabled = settings.ai_enabled;
    const portalLinked = await this.employeesService.hasPortalEmployeeLink(companyId, employeeId);
    const roleAiOk = portalLinked ? settings.ai_for_employees_enabled : settings.ai_for_managers_enabled;
    const employeeAiEnabled = await this.employeesService.isAutoAiEnabledForEmployee(companyId, employeeId);
    if (
      aiEnabled &&
      roleAiOk &&
      employeeAiEnabled &&
      this.aiEnrichmentService.shouldEnrich({
        follow_up_required: result.followUpRequired,
        priority: row.priority,
        summary: row.summary,
        follow_up_status: result.followUpStatus,
        delay_hours: result.delayHours,
        sla_hours: slaHours,
      })
    ) {
      try {
        await this.aiEnrichmentService.enrichConversation(conversationId, employeeId, threadId);
        enriched = true;
        this.logger.log(`AI enriched conversation ${conversationId}`);
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
}
