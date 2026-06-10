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
import {
  buildSharedIngestRelevancePrompt,
  RELEVANCE_MODEL_TEMPERATURE,
  RELEVANCE_SYSTEM_INSTRUCTION,
} from '../email-ingestion/relevance-prompt.builder';
import {
  ingestForceRelevantCalendarOrMeeting,
  ingestSkipReasonForInboundNoise,
  looksLikeDirectHumanMail,
  finalizeIngestRelevanceFromAi,
} from '../email-ingestion/relevance-guards';
import { OauthTokenService } from '../auth/oauth-token.service';
import { ConversationsService } from '../conversations/conversations.service';
import { SettingsService } from '../settings/settings.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import { EmailMessage } from '../common/types';
import { getGeminiApiKeyFromEnv } from '../common/env';
import {
  isGeminiMonthlyQuotaExhausted,
  isGeminiTransientRateLimit,
} from '../common/gemini-quota-probe';
import { RequestContext } from '../common/request-context';
import type { ConversationListItem } from '../dashboard/dashboard.service';
import { SelfTrackingService } from './self-tracking.service';
import { EmailIngestionService } from '../email-ingestion/email-ingestion.service';
import { AiEnrichmentService } from '../ai-enrichment/ai-enrichment.service';
import type { gmail_v1 } from 'googleapis';

const MAX_HISTORICAL_RANGE_DAYS = 731;
const MAX_HISTORICAL_MESSAGES = 500;
const MAX_STORED_EMAIL_BODY_CHARS = 2_000_000;

/** Inbound + mailbox not directly addressed (CC'd or BCC'd, not in To). */
function employeeOnlyOnCc(msg: EmailMessage, employeeEmail: string): boolean {
  if (msg.direction !== 'INBOUND') return false;
  const n = (e: string) => e.trim().toLowerCase();
  const em = n(employeeEmail);
  const inTo = (msg.toEmails ?? []).some((t) => n(t) === em);
  return !inTo;
}

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
  /** True when the client disconnected or aborted mid-run; partial data was still saved. */
  stopped?: boolean;
  /** Set when the run was persisted to `historical_search_runs`. */
  run_id?: string | null;
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
      /** Present when the full message was loaded (helps the UI mirror Live Mails). */
      from_name?: string | null;
      message_id?: string;
      thread_id?: string;
      direction?: 'INBOUND' | 'OUTBOUND';
      sent_at_iso?: string;
      user_cc_only?: boolean;
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
  private monthlyQuotaExhausted = false;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gmailService: GmailService,
    private readonly oauthTokenService: OauthTokenService,
    private readonly conversationsService: ConversationsService,
    private readonly settingsService: SettingsService,
    private readonly companyPolicyService: CompanyPolicyService,
    private readonly selfTrackingService: SelfTrackingService,
    private readonly emailIngestionService: EmailIngestionService,
    private readonly aiEnrichmentService: AiEnrichmentService,
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
      systemInstruction: RELEVANCE_SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: RELEVANCE_MODEL_TEMPERATURE,
        responseMimeType: 'application/json',
      },
    });
  }

  async fetchHistorical(
    ctx: RequestContext,
    employeeId: string,
    startIso: string,
    endIso: string,
    onProgress?: HistoricalProgressFn,
    options?: { abortSignal?: AbortSignal; createdByUserId?: string },
  ): Promise<HistoricalFetchResult> {
    if (await this.settingsService.isApiQuotaExhausted()) {
      const recovered = await this.settingsService.tryAutoClearApiQuotaIfRenewed({ throttleMs: 90_000 });
      if (!recovered) {
        throw new BadRequestException(
          'API credits are exhausted — all operations are halted (sync, storage, alerts). ' +
            'Sync will resume automatically when Google AI Studio accepts requests again.',
        );
      }
    }

    this.monthlyQuotaExhausted = false;
    this.aiEnrichmentService.resetMonthlyQuotaGate();
    const signal = options?.abortSignal;
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

    const companyEmailCrawlOn = await this.companyPolicyService.isEmailCrawlEnabledForCompany(ctx.companyId);
    if (!companyEmailCrawlOn) {
      throw new BadRequestException('Email crawl is disabled by Platform Admin for this company.');
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
      const inWindow = await this.selfTrackingService.listConversationsByLastClientMsgWindow(
        ctx,
        employeeId,
        employee.name,
        startIso.trim(),
        endIso.trim(),
      );
      const emptyBase: HistoricalFetchResult = {
        fetched_from_gmail: 0,
        stored_relevant: 0,
        skipped_irrelevant: 0,
        conversations_created: 0,
        conversations: inWindow,
      };
      const empty = await this.finalizeHistoricalRun(
        ctx,
        employeeId,
        employee.name,
        startIso.trim(),
        endIso.trim(),
        emptyBase,
        options?.createdByUserId,
      );
      onProgress?.({ phase: 'complete', result: empty });
      return empty;
    }

    // Gmail search returns newest-first. Replay the selected window oldest-first
    // so the progress card moves from the user's start date toward "now" without
    // doing an expensive pre-scan before AI analysis starts.
    const orderedMessageIds = [...messageIds].reverse();

    const companyAiOn = await this.companyPolicyService.isAiEnabledForCompany(ctx.companyId);
    const settings = await this.settingsService.getAll();
    const allowGeminiRelevance =
      Boolean(this.relevanceModel) &&
      companyAiOn &&
      settings.email_ai_relevance_enabled &&
      employee.ai_enabled !== false;
    const ingestWithoutAiConfirmed = settings.email_ingest_without_ai_confirmed;
    const inboundAiRequired = !ingestWithoutAiConfirmed;
    if (inboundAiRequired && !allowGeminiRelevance) {
      const reasons: string[] = [];
      if (!this.relevanceModel) {
        reasons.push('Inbox AI is not configured on the server (missing Gemini API key).');
      }
      if (!companyAiOn) {
        reasons.push('Company AI is disabled.');
      }
      if (!settings.email_ai_relevance_enabled) {
        reasons.push('Inbox AI relevance is turned off in Settings.');
      }
      if (employee.ai_enabled === false) {
        reasons.push('Mailbox AI is turned off for this inbox.');
      }
      const detail = reasons.join(' ') || 'Inbox AI is required but not available.';
      throw new BadRequestException(
        `${detail} Enable Inbox AI, or confirm “import without Inbox AI” on My Email before running a historical backfill.`,
      );
    }

    const threadMetaCache = new Map<string, gmail_v1.Schema$Message[]>();
    const messages: EmailMessage[] = [];
    const affectedThreads = new Set<string>();
    let skippedIrrelevant = 0;
    let fetchedCount = 0;
    let storedRelevantCount = 0;
    let conversationsCreated = 0;

    const total = orderedMessageIds.length;
    let stoppedEarly = false;

    const flushRelevantBatch = async (): Promise<void> => {
      if (messages.length === 0) return;
      const batch = [...messages];
      const batchThreadIds = [...new Set(batch.map((m) => m.providerThreadId))];
      onProgress?.({ phase: 'saving', messageCount: storedRelevantCount + batch.length });
      await this.storeMessages(ctx.companyId, employeeId, batch);
      messages.splice(0, batch.length);
      storedRelevantCount += batch.length;

      if (batchThreadIds.length > 0) {
        onProgress?.({ phase: 'recomputing', threadCount: affectedThreads.size });
        const threadKeys = batchThreadIds.map((threadId) => ({
          companyId: ctx.companyId,
          employeeId,
          threadId,
        }));
        const rc = await this.conversationsService.recomputeForThreads(threadKeys);
        conversationsCreated += rc.created + rc.updated;
      }
    };

    for (let idx = 0; idx < orderedMessageIds.length; idx++) {
      if (signal?.aborted) {
        stoppedEarly = true;
        break;
      }
      const msgId = orderedMessageIds[idx];
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
        if (signal?.aborted) {
          stoppedEarly = true;
          break;
        }
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

        if (signal?.aborted) {
          stoppedEarly = true;
          break;
        }

        if (await this.conversationsService.isThreadPermanentlyResolved(employeeId, msg.providerThreadId)) {
          onProgress?.({
            phase: 'ai_decision',
            index,
            total,
            relevant: false,
            reason: 'Thread resolved and removed by user',
            subject: msg.subject ?? '(no subject)',
            from: msg.fromEmail,
          });
          continue;
        }

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
            1,
          );
        }

        if (signal?.aborted) {
          stoppedEarly = true;
          break;
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
          from_name: msg.fromName?.trim() ? msg.fromName.trim() : null,
          message_id: msg.providerMessageId,
          thread_id: msg.providerThreadId,
          direction: msg.direction,
          sent_at_iso: msg.sentAt.toISOString(),
          user_cc_only: employeeOnlyOnCc(msg, employee.email),
        });

        if (!decision.relevant) {
          if (decision.inboundAiHardStop) {
            skippedIrrelevant++;
            stoppedEarly = true;
            this.logger.warn(
              `Historical fetch paused for ${employee.email}: ${decision.reason ?? 'Inbox AI unavailable'}`,
            );
            break;
          }
          skippedIrrelevant++;
          if (decision.transientAiUnavailable) {
            const reasonText =
              decision.reason?.trim() ||
              'Inbox AI temporarily unavailable — retry or use Reanalyze.';
            const isQuota = /quota|rate limit|\b429\b/i.test(reasonText);
            try {
              await this.emailIngestionService.recordIngestionSkip(employeeId, msg.providerMessageId, {
                skip_kind: isQuota ? 'quota_exceeded' : 'ai_irrelevant',
                skip_reason: reasonText,
                classification_status: 'failed',
                subject: msg.subject,
                from_email: msg.fromEmail,
                sent_at: msg.sentAt,
                provider_thread_id: msg.providerThreadId,
              });
            } catch (skipErr) {
              this.logger.warn(
                `Historical fetch: could not record transient skip for ${msgId}: ${(skipErr as Error).message}`,
              );
            }
            continue;
          }
          const reasonText =
            decision.reason?.trim() || 'Marked not relevant by Inbox AI (historical search).';
          try {
            await this.emailIngestionService.recordIngestionSkip(employeeId, msg.providerMessageId, {
              skip_kind: 'ai_irrelevant',
              skip_reason: reasonText,
              subject: msg.subject,
              from_email: msg.fromEmail,
              sent_at: msg.sentAt,
              provider_thread_id: msg.providerThreadId,
            });
          } catch (skipErr) {
            this.logger.warn(
              `Historical fetch: could not record skip for ${msgId}: ${(skipErr as Error).message}`,
            );
          }
          continue;
        }

        if (decision.reason) {
          msg.relevanceReason = decision.reason;
        }
        msg.aiAction = decision.reason?.match(/^\[(NEED_REPLY|CC|CALENDAR|LOW|SKIP)\]/)?.[1] ?? null;

        messages.push(msg);
        affectedThreads.add(msg.providerThreadId);
        threadMetaCache.delete(msg.providerThreadId);
        // Make the CEO portal feel live: once AI accepts a message, write and recompute
        // that thread right away so it can appear in Need reply / Waiting / CC'd / Done.
        await flushRelevantBatch();
      } catch (err) {
        this.logger.warn(`Historical fetch: skip message ${msgId}: ${(err as Error).message}`);
      }
    }

    await flushRelevantBatch();

    const fromNewThreads = await this.loadNewConversations(
      ctx.companyId,
      employeeId,
      [...affectedThreads],
      employee.name,
    );
    const inWindow = await this.selfTrackingService.listConversationsByLastClientMsgWindow(
      ctx,
      employeeId,
      employee.name,
      startIso.trim(),
      endIso.trim(),
    );
    const conversations = this.mergeHistoricalConversationViews(fromNewThreads, inWindow);

    this.logger.log(
      `Historical fetch done: ${fetchedCount} fetched, ${storedRelevantCount} stored, ${skippedIrrelevant} skipped, ${conversationsCreated} conversations`,
    );

    const wasStopped = stoppedEarly || Boolean(signal?.aborted);
    const resultBase: HistoricalFetchResult = {
      fetched_from_gmail: fetchedCount,
      stored_relevant: storedRelevantCount,
      skipped_irrelevant: skippedIrrelevant,
      conversations_created: conversationsCreated,
      conversations,
      stopped: wasStopped || undefined,
    };
    const result = await this.finalizeHistoricalRun(
      ctx,
      employeeId,
      employee.name,
      startIso.trim(),
      endIso.trim(),
      resultBase,
      options?.createdByUserId,
    );
    onProgress?.({ phase: 'complete', result });
    return result;
  }

  private async finalizeHistoricalRun(
    ctx: RequestContext,
    employeeId: string,
    mailboxName: string,
    startIso: string,
    endIso: string,
    base: HistoricalFetchResult,
    createdByUserId?: string,
  ): Promise<HistoricalFetchResult> {
    if (!base.stopped) {
      const nowIso = new Date().toISOString();
      await this.supabase
        .from('employees')
        .update({
          last_synced_at: nowIso,
          last_gmail_sync_at: nowIso,
          last_ai_analysis_at: nowIso,
          gmail_status: 'CONNECTED',
        })
        .eq('id', employeeId)
        .eq('company_id', ctx.companyId);

      await this.supabase.from('mail_sync_state').upsert(
        {
          employee_id: employeeId,
          start_date: startIso,
          last_processed_at: endIso,
          gmail_list_page_token: null,
          gmail_list_query_after_epoch: null,
          backfill_max_sent_at: null,
          updated_at: nowIso,
        },
        { onConflict: 'employee_id' },
      );
    }

    const uid = createdByUserId?.trim();
    if (!uid) return base;
    const run_id = await this.selfTrackingService.recordHistoricalSearchRun(ctx, {
      createdByUserId: uid,
      employeeId,
      mailboxName,
      startIso,
      endIso,
      stats: {
        fetched_from_gmail: base.fetched_from_gmail,
        stored_relevant: base.stored_relevant,
        skipped_irrelevant: base.skipped_irrelevant,
        conversations_created: base.conversations_created,
        ...(base.stopped ? { stopped: true } : {}),
      },
      conversationCount: base.conversations.length,
    });
    return run_id ? { ...base, run_id } : base;
  }

  /** Union by conversation id; prefer rows from the current fetch when duplicates exist. */
  private mergeHistoricalConversationViews(
    fromFetch: ConversationListItem[],
    inDateWindow: ConversationListItem[],
  ): ConversationListItem[] {
    const byId = new Map<string, ConversationListItem>();
    for (const c of inDateWindow) byId.set(c.conversation_id, c);
    for (const c of fromFetch) byId.set(c.conversation_id, c);
    return [...byId.values()].sort(
      (a, b) =>
        new Date(b.last_client_msg_at ?? 0).getTime() - new Date(a.last_client_msg_at ?? 0).getTime(),
    );
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

  /** Same retry behavior as live ingestion so transient 429s do not blank a whole historical window. */
  private async callGeminiRelevance(
    prompt: string,
  ): Promise<{ relevant: boolean; reason: string | null; confidence: number | null } | null> {
    if (!this.relevanceModel) return null;
    if (this.monthlyQuotaExhausted) {
      return null;
    }
    const VALID_ACTIONS = new Set(['NEED_REPLY', 'CC', 'CALENDAR', 'LOW', 'SKIP']);
    const retries = 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.relevanceModel.generateContent(prompt);
        const text = result.response.text().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(text) as {
          action?: string;
          relevant?: boolean;
          reason?: string;
          confidence?: number;
        };
        const action = (parsed.action ?? '').toUpperCase();
        if (VALID_ACTIONS.has(action)) {
          const reason = typeof parsed.reason === 'string' ? `[${action}] ${parsed.reason.trim().slice(0, 500)}` : `[${action}]`;
          return { relevant: action !== 'SKIP', reason, confidence: null };
        }
        if (typeof parsed.relevant === 'boolean') {
          const confidence =
            typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
              ? Math.max(0, Math.min(1, parsed.confidence))
              : null;
          return {
            relevant: parsed.relevant,
            reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 500) : null,
            confidence,
          };
        }
        this.logger.warn('Historical Gemini relevance: JSON missing boolean relevant flag');
        return null;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (isGeminiMonthlyQuotaExhausted(msg)) {
          this.monthlyQuotaExhausted = true;
          this.logger.warn(
            `Gemini spend cap reported — skipping further AI calls this run (sync continues). ${msg.slice(0, 200)}`,
          );
          return null;
        }
        if (attempt < retries) {
          const backoff = isGeminiTransientRateLimit(msg)
            ? 2000 * Math.pow(2, attempt)
            : 400 * Math.pow(2, attempt);
          this.logger.warn(
            `Historical Gemini relevance failed (attempt ${attempt + 1}/${retries + 1}) — retry in ${backoff}ms: ${msg.slice(0, 200)}`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        this.logger.warn(`Historical Gemini relevance failed after retries: ${msg.slice(0, 200)}`);
        return null;
      }
    }
    return null;
  }

  private async classifyMessage(
    target: EmailMessage,
    threadSlice: EmailMessage[],
    employeeEmail: string,
    hasNoiseGmailLabel: boolean,
    allowGeminiRelevance: boolean,
    ingestWithoutAiConfirmed: boolean,
  ): Promise<{
    relevant: boolean;
    reason: string | null;
    inboundAiHardStop?: boolean;
    transientAiUnavailable?: boolean;
  }> {
    if (target.direction === 'OUTBOUND') {
      return {
        relevant: true,
        reason: 'Outbound — your sent message (reply detection / SLA)',
      };
    }
    const calendarIngest = ingestForceRelevantCalendarOrMeeting(target);
    if (calendarIngest) {
      return calendarIngest;
    }
    const noiseSkip = ingestSkipReasonForInboundNoise(target, hasNoiseGmailLabel);
    if (noiseSkip) {
      return { relevant: false, reason: noiseSkip };
    }

    // CC-only / BCC pre-filter: mailbox not in To → CC tab (no Gemini needed)
    if (target.direction === 'INBOUND') {
      const m = employeeEmail.trim().toLowerCase();
      const inTo = (target.toEmails ?? []).some((e) => e.trim().toLowerCase() === m);
      if (!inTo) {
        const inCc = (target.ccEmails ?? []).some((e) => e.trim().toLowerCase() === m);
        if (inCc) {
          return { relevant: true, reason: 'Mailbox only in CC — no reply expected.' };
        }
        return { relevant: true, reason: 'Mailbox BCC — informational only.' };
      }
    }

    if (allowGeminiRelevance && this.relevanceModel) {
      const sliceWithTarget = this.sortThreadChronological(
        threadSlice.some((m) => m.providerMessageId === target.providerMessageId)
          ? threadSlice
          : [...threadSlice, target],
      );
      const prompt = buildSharedIngestRelevancePrompt(target, sliceWithTarget, employeeEmail, hasNoiseGmailLabel);
      const parsed = await this.callGeminiRelevance(prompt);
      if (parsed) {
        const finalized = finalizeIngestRelevanceFromAi(
          target,
          employeeEmail,
          hasNoiseGmailLabel,
          parsed,
        );
        return {
          relevant: finalized.relevant,
          reason: finalized.reason,
        };
      }
      if (this.monthlyQuotaExhausted && !ingestWithoutAiConfirmed) {
        if (looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel)) {
          return {
            relevant: true,
            reason:
              'Safety fallback: direct human mailbox message kept while Inbox AI is temporarily unavailable.',
          };
        }
        return {
          relevant: false,
          reason:
            'Inbox AI unavailable: Gemini API quota or rate limit reached.',
          transientAiUnavailable: true,
        };
      }
      if (ingestWithoutAiConfirmed) {
        return { relevant: true, reason: 'Unfiltered import — Inbox AI unavailable' };
      }
      if (looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel)) {
        return {
          relevant: true,
          reason:
            'Safety fallback: direct human mailbox message kept while Inbox AI is temporarily unavailable.',
        };
      }
      return {
        relevant: false,
        reason:
          'Inbox AI unavailable: Gemini did not return a usable verdict.',
        transientAiUnavailable: true,
      };
    }
    if (ingestWithoutAiConfirmed) {
      return { relevant: true, reason: 'Unfiltered import — Inbox AI unavailable' };
    }
    if (looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel)) {
      return {
        relevant: true,
        reason:
          'Safety fallback: direct human mailbox message kept while Inbox AI is unavailable.',
      };
    }
    return {
      relevant: true,
      reason: 'AI temporarily unavailable — kept as Need Reply (safe default).',
    };
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

    const mapped = (data as Row[]).map((r) => {
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
        thread_subject: null as string | null,
        open_gmail_link: `https://mail.google.com/mail/u/0/#inbox/${tid}`,
        updated_at: r.updated_at,
      };
    });
    return this.conversationsService.attachThreadSubjects(mapped);
  }
}
