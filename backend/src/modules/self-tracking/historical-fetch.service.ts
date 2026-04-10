import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { GmailService, buildGmailHistoricalWindowQuery } from '../email-ingestion/gmail.service';
import { OauthTokenService } from '../auth/oauth-token.service';
import { ConversationsService } from '../conversations/conversations.service';
import { SettingsService } from '../settings/settings.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import { EmailMessage } from '../common/types';
import { getGeminiApiKeyFromEnv } from '../common/env';
import { RequestContext } from '../common/request-context';
import type { ConversationListItem } from '../dashboard/dashboard.service';
import type { gmail_v1 } from 'googleapis';

const MAX_HISTORICAL_RANGE_DAYS = 731;
const MAX_HISTORICAL_MESSAGES = 500;
const MAX_STORED_EMAIL_BODY_CHARS = 2_000_000;
const RELEVANCE_PROMPT_PER_MESSAGE_BODY = 1_400;

function clipStoredBody(bodyText: string | undefined): string {
  const t = bodyText ?? '';
  if (t.length <= MAX_STORED_EMAIL_BODY_CHARS) return t;
  return t.slice(0, MAX_STORED_EMAIL_BODY_CHARS) + '\n\n[Truncated]';
}

export interface HistoricalFetchResult {
  fetched_from_gmail: number;
  stored_relevant: number;
  skipped_irrelevant: number;
  conversations_created: number;
  conversations: ConversationListItem[];
}

/** Streamed to the client for live progress (Historical Search UI). */
export type HistoricalProgressEvent =
  | { phase: 'listed'; totalIds: number }
  | { phase: 'message'; index: number; total: number; step: 'start' | 'downloaded'; messageId?: string; subject?: string; from?: string }
  | {
      phase: 'ai_decision';
      index: number;
      total: number;
      relevant: boolean;
      reason: string | null;
      subject: string;
      from: string;
    }
  | { phase: 'saving'; messageCount: number }
  | { phase: 'recomputing'; threadCount: number }
  | { phase: 'complete'; result: HistoricalFetchResult }
  | { phase: 'error'; message: string };

export type HistoricalProgressFn = (e: HistoricalProgressEvent) => void;

@Injectable()
export class HistoricalFetchService {
  private readonly logger = new Logger(HistoricalFetchService.name);
  private readonly relevanceModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gmailService: GmailService,
    private readonly oauthTokenService: OauthTokenService,
    private readonly conversationsService: ConversationsService,
    private readonly settingsService: SettingsService,
    private readonly companyPolicyService: CompanyPolicyService,
  ) {
    const key = getGeminiApiKeyFromEnv();
    if (!key) {
      this.relevanceModel = null;
      return;
    }
    const genAI = new GoogleGenerativeAI(key);
    const modelName = process.env.GEMINI_RELEVANCE_MODEL?.trim() || 'gemini-2.5-flash';
    this.relevanceModel = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    });
  }

  async fetchHistorical(
    ctx: RequestContext,
    employeeId: string,
    startIso: string,
    endIso: string,
    onProgress?: HistoricalProgressFn,
  ): Promise<HistoricalFetchResult> {
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new BadRequestException('Invalid start or end date');
    }
    if (endMs < startMs) {
      throw new BadRequestException('End must be on or after start');
    }
    const rangeDays = (endMs - startMs) / 86_400_000;
    if (rangeDays > MAX_HISTORICAL_RANGE_DAYS) {
      throw new BadRequestException(`Date range cannot exceed ${MAX_HISTORICAL_RANGE_DAYS} days`);
    }

    const hasOAuth = await this.oauthTokenService.hasToken(employeeId);
    if (!hasOAuth) {
      throw new BadRequestException('Gmail is not connected for this mailbox. Connect Gmail first.');
    }

    const { data: empRow } = await this.supabase
      .from('employees')
      .select('id, name, email, company_id, ai_enabled')
      .eq('id', employeeId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();

    if (!empRow) {
      throw new BadRequestException('Mailbox not found or not in your company');
    }

    const employee = empRow as { id: string; name: string; email: string; company_id: string; ai_enabled?: boolean };

    this.logger.log(
      `Historical fetch for ${employee.name} (${employee.email}): ${startIso} → ${endIso}`,
    );

    const startDate = new Date(startMs);
    const endDate = new Date(endMs);

    const listQuery = buildGmailHistoricalWindowQuery(startDate, endDate);

    const messageIds: string[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 10; page++) {
      const { ids, nextPageToken } = await this.gmailService.listMessageIdsPage(
        employeeId,
        listQuery,
        { maxResults: 200, pageToken },
      );
      messageIds.push(...ids);
      if (!nextPageToken || messageIds.length >= MAX_HISTORICAL_MESSAGES) break;
      pageToken = nextPageToken;
    }

    onProgress?.({ phase: 'listed', totalIds: messageIds.length });

    if (messageIds.length === 0) {
      const empty: HistoricalFetchResult = {
        fetched_from_gmail: 0,
        stored_relevant: 0,
        skipped_irrelevant: 0,
        conversations_created: 0,
        conversations: [],
      };
      onProgress?.({ phase: 'complete', result: empty });
      return empty;
    }

    const companyAiOn = await this.companyPolicyService.isAiEnabledForCompany(ctx.companyId);
    const settings = await this.settingsService.getAll();
    const allowGeminiRelevance =
      Boolean(this.relevanceModel) &&
      companyAiOn &&
      settings.email_ai_relevance_enabled &&
      employee.ai_enabled !== false;
    const ingestWithoutAiConfirmed = settings.email_ingest_without_ai_confirmed;

    const threadMetaCache = new Map<string, gmail_v1.Schema$Message[]>();
    const messages: EmailMessage[] = [];
    const affectedThreads = new Set<string>();
    let skippedIrrelevant = 0;
    let fetchedCount = 0;

    const total = messageIds.length;

    for (let idx = 0; idx < messageIds.length; idx++) {
      const msgId = messageIds[idx];
      const index = idx + 1;
      onProgress?.({
        phase: 'message',
        index,
        total,
        step: 'start',
        messageId: msgId,
      });

      if (await this.messageAlreadyStored(employeeId, msgId)) {
        onProgress?.({
          phase: 'ai_decision',
          index,
          total,
          relevant: false,
          reason: 'Already synced',
          subject: '—',
          from: '—',
        });
        continue;
      }

      try {
        const msg = await this.gmailService.fetchFullMessage(employeeId, employee.email, msgId);
        fetchedCount++;

        onProgress?.({
          phase: 'message',
          index,
          total,
          step: 'downloaded',
          messageId: msgId,
          subject: msg.subject ?? '(no subject)',
          from: msg.fromEmail,
        });

        if (msg.sentAt < startDate || msg.sentAt > endDate) {
          onProgress?.({
            phase: 'ai_decision',
            index,
            total,
            relevant: false,
            reason: 'Outside selected date range',
            subject: msg.subject ?? '(no subject)',
            from: msg.fromEmail,
          });
          continue;
        }

        let threadSlice: EmailMessage[] = [msg];
        if (allowGeminiRelevance && this.relevanceModel) {
          threadSlice = await this.gmailService.fetchLastMessagesInThreadForRelevance(
            employeeId,
            employee.email,
            msg,
            threadMetaCache,
            3,
          );
        }

        const decision = await this.classifyMessage(
          msg,
          threadSlice,
          employee.email,
          this.gmailService.isNoise(msg.labelIds),
          allowGeminiRelevance,
          ingestWithoutAiConfirmed,
        );

        onProgress?.({
          phase: 'ai_decision',
          index,
          total,
          relevant: decision.relevant,
          reason: decision.reason,
          subject: msg.subject ?? '(no subject)',
          from: msg.fromEmail,
        });

        if (!decision.relevant) {
          skippedIrrelevant++;
          continue;
        }

        if (decision.reason) {
          msg.relevanceReason = decision.reason;
        }

        messages.push(msg);
        affectedThreads.add(msg.providerThreadId);
        threadMetaCache.delete(msg.providerThreadId);
      } catch (err) {
        this.logger.warn(`Historical fetch: skip message ${msgId}: ${(err as Error).message}`);
      }
    }

    if (messages.length > 0) {
      onProgress?.({ phase: 'saving', messageCount: messages.length });
      await this.storeMessages(ctx.companyId, employeeId, messages);
    }

    let conversationsCreated = 0;
    if (affectedThreads.size > 0) {
      onProgress?.({ phase: 'recomputing', threadCount: affectedThreads.size });
      const threadKeys = [...affectedThreads].map((threadId) => ({
        companyId: ctx.companyId,
        employeeId,
        threadId,
      }));
      const rc = await this.conversationsService.recomputeForThreads(threadKeys);
      conversationsCreated = rc.created + rc.updated;
    }

    const conversations = await this.loadNewConversations(
      ctx.companyId,
      employeeId,
      [...affectedThreads],
      employee.name,
    );

    this.logger.log(
      `Historical fetch done: ${fetchedCount} fetched, ${messages.length} stored, ${skippedIrrelevant} skipped, ${conversationsCreated} conversations`,
    );

    const result: HistoricalFetchResult = {
      fetched_from_gmail: fetchedCount,
      stored_relevant: messages.length,
      skipped_irrelevant: skippedIrrelevant,
      conversations_created: conversationsCreated,
      conversations,
    };
    onProgress?.({ phase: 'complete', result });
    return result;
  }

  private async messageAlreadyStored(employeeId: string, providerMessageId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('email_messages')
      .select('provider_message_id')
      .eq('employee_id', employeeId)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    return data !== null;
  }

  private sortThreadChronological(slice: EmailMessage[]): EmailMessage[] {
    return [...slice].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  private buildRelevancePrompt(
    target: EmailMessage,
    threadSlice: EmailMessage[],
    employeeEmail: string,
    hasNoiseGmailLabel: boolean,
  ): string {
    const ordered = this.sortThreadChronological(threadSlice);
    const threadBlocks = ordered.map((m, idx) => {
      const isTarget = m.providerMessageId === target.providerMessageId;
      const body = (m.bodyText ?? '').slice(0, RELEVANCE_PROMPT_PER_MESSAGE_BODY);
      return [
        `### Part ${idx + 1}/${ordered.length} — classification_target=${isTarget ? 'YES' : 'no'}`,
        `gmail_message_id: ${m.providerMessageId}`,
        `direction: ${m.direction}`,
        `sent_at: ${m.sentAt.toISOString()}`,
        `from: ${m.fromEmail}`,
        `to: ${(m.toEmails ?? []).join(', ')}`,
        `cc: ${(m.ccEmails ?? []).join(', ')}`,
        `subject: ${m.subject ?? ''}`,
        '',
        'body_text:',
        body,
      ].join('\n');
    });

    return [
      '## Role',
      'You are the gatekeeper for a business email follow-up product.',
      'Decide if the target message is relevant (needs tracking/reply) or noise.',
      '',
      '## Output',
      'Return ONLY valid JSON: {"relevant":true|false,"reason":"one sentence"}',
      '',
      `tracked_mailbox: ${employeeEmail}`,
      `gmail_noise_hint=${hasNoiseGmailLabel ? 'yes' : 'no'}`,
      '',
      '## Thread',
      ...threadBlocks,
    ].join('\n');
  }

  private async callGeminiRelevance(prompt: string): Promise<{ relevant: boolean; reason: string | null } | null> {
    if (!this.relevanceModel) return null;
    try {
      const result = await this.relevanceModel.generateContent(prompt);
      const text = result.response.text().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(text) as { relevant?: boolean; reason?: string };
      if (typeof parsed.relevant === 'boolean') {
        return {
          relevant: parsed.relevant,
          reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 500) : null,
        };
      }
      return null;
    } catch (err) {
      this.logger.warn(`Gemini relevance error: ${(err as Error).message?.slice(0, 200)}`);
      return null;
    }
  }

  private async classifyMessage(
    target: EmailMessage,
    threadSlice: EmailMessage[],
    employeeEmail: string,
    hasNoiseGmailLabel: boolean,
    allowGeminiRelevance: boolean,
    ingestWithoutAiConfirmed: boolean,
  ): Promise<{ relevant: boolean; reason: string | null }> {
    if (target.direction === 'OUTBOUND') {
      return {
        relevant: true,
        reason: 'Outbound — your sent message (reply detection / SLA)',
      };
    }
    if (allowGeminiRelevance && this.relevanceModel) {
      const sliceWithTarget = this.sortThreadChronological(
        threadSlice.some((m) => m.providerMessageId === target.providerMessageId)
          ? threadSlice
          : [...threadSlice, target],
      );
      const prompt = this.buildRelevancePrompt(target, sliceWithTarget, employeeEmail, hasNoiseGmailLabel);
      const parsed = await this.callGeminiRelevance(prompt);
      if (parsed) return parsed;
      return { relevant: ingestWithoutAiConfirmed, reason: null };
    }
    if (ingestWithoutAiConfirmed) {
      return { relevant: true, reason: 'Unfiltered import — Inbox AI unavailable' };
    }
    return { relevant: false, reason: null };
  }

  private async storeMessages(companyId: string, employeeId: string, messages: EmailMessage[]): Promise<void> {
    const rows = messages.map((msg) => ({
      provider_message_id: msg.providerMessageId,
      provider_thread_id: msg.providerThreadId,
      employee_id: employeeId,
      company_id: companyId,
      direction: msg.direction,
      from_email: msg.fromEmail,
      from_name: msg.fromName ?? null,
      reply_to_email: msg.replyToEmail ?? null,
      to_emails: msg.toEmails,
      cc_emails: msg.ccEmails ?? [],
      subject: msg.subject,
      body_text: clipStoredBody(msg.bodyText),
      sent_at: msg.sentAt.toISOString(),
      ingested_at: new Date().toISOString(),
      relevance_reason: msg.relevanceReason?.trim() ? msg.relevanceReason.trim().slice(0, 2000) : null,
    }));

    let { error } = await this.supabase
      .from('email_messages')
      .upsert(rows, { onConflict: 'provider_message_id' });

    if (error && String(error.message ?? '').includes('cc_emails')) {
      const noCc = rows.map(({ cc_emails: _c, ...rest }) => rest);
      const second = await this.supabase.from('email_messages').upsert(noCc, { onConflict: 'provider_message_id' });
      if (!second.error) {
        this.logger.warn('Historical fetch: cc_emails missing — legacy upsert; run migration 019.');
        return;
      }
      error = second.error;
    }

    if (error) {
      const legacyRows = rows.map(
        ({ relevance_reason: _rr, from_name: _n, reply_to_email: _r, cc_emails: _c, ...rest }) => rest,
      );
      const { error: legacyErr } = await this.supabase
        .from('email_messages')
        .upsert(legacyRows, { onConflict: 'provider_message_id' });
      if (legacyErr) {
        this.logger.error('Historical fetch: failed to store messages', legacyErr.message);
        throw legacyErr;
      }
    }
  }

  private async loadNewConversations(
    companyId: string,
    employeeId: string,
    threadIds: string[],
    employeeName: string,
  ): Promise<ConversationListItem[]> {
    if (threadIds.length === 0) return [];

    const convIds = threadIds.map((tid) => `${employeeId}:${tid}`);

    const { data, error } = await this.supabase
      .from('conversations')
      .select(
        'conversation_id, employee_id, provider_thread_id, client_name, client_email, follow_up_status, priority, delay_hours, summary, short_reason, reason, last_client_msg_at, last_employee_reply_at, follow_up_required, confidence, lifecycle_status, manually_closed, is_ignored, user_cc_only, updated_at',
      )
      .eq('company_id', companyId)
      .eq('is_ignored', false)
      .in('conversation_id', convIds)
      .order('last_client_msg_at', { ascending: false });

    if (error || !data) return [];

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

    return (data as Row[]).map((r) => {
      const tid = encodeURIComponent(r.provider_thread_id);
      return {
        conversation_id: r.conversation_id,
        employee_id: r.employee_id,
        employee_name: employeeName,
        provider_thread_id: r.provider_thread_id,
        client_name: r.client_name,
        client_email: r.client_email,
        follow_up_status: r.follow_up_status,
        priority: r.priority,
        delay_hours: r.delay_hours,
        sla_hours: 24,
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
}
