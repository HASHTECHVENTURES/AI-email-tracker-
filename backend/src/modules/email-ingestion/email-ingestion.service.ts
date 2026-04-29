import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { Employee, EmailMessage } from '../common/types';
import { EmployeesService } from '../employees/employees.service';
import { ConversationsService } from '../conversations/conversations.service';
import { SettingsService, type SystemSettings } from '../settings/settings.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { CompanyPolicyService } from '../company-policy/company-policy.service';
import { AiEnrichmentService } from '../ai-enrichment/ai-enrichment.service';
import type { gmail_v1 } from 'googleapis';
import {
  buildGmailHistoricalWindowQuery,
  buildGmailInboxListQuery,
  GmailService,
} from './gmail.service';
import { buildSharedIngestRelevancePrompt } from './relevance-prompt.builder';
import { OauthTokenService } from '../auth/oauth-token.service';
import { getGeminiApiKeyFromEnv } from '../common/env';

interface IngestionResult {
  companyId?: string;
  employeeId: string;
  employeeName: string;
  newMessages: number;
  skippedFiltered: number;
  affectedThreads: number;
  conversationsUpdated: number;
  error?: string;
}

/** Read-only probe: same Gmail `messages.list` query as the next incremental run (does not change sync state). */
export interface MailFetchProbeResult {
  ok: boolean;
  employee_id: string;
  employee_email: string;
  employee_name: string;
  oauth_configured: boolean;
  live: {
    list_after_iso: string;
    list_query: string;
    resuming_paged_list: boolean;
    pages_fetched: number;
    message_ids_counted: number;
    has_more_list_pages: boolean;
    gmail_error: string | null;
  };
  historical?: {
    start_iso: string;
    end_iso: string;
    list_query: string;
    pages_fetched: number;
    message_ids_counted: number;
    has_more_list_pages: boolean;
    gmail_error: string | null;
  };
  database: {
    total_email_messages_stored: number;
  };
  notes: string[];
}

/** Gmail returns newest-first; we page with a stored token so older mail is not skipped. */
const GMAIL_LIST_PAGE_SIZE_DEFAULT = 200;
/** How many messages.list pages to walk in one ingestion run (then cron continues). Speeds backfill. */
const GMAIL_LIST_MAX_PAGES_DEFAULT = 6;
/**
 * Cap stored plain-text body size (~2MB) for pathological messages. We still persist the full Gmail-derived
 * body below this limit (HTML→text); older builds truncated at 2k chars — re-run sync to refresh rows.
 */
const MAX_STORED_EMAIL_BODY_CHARS = 2_000_000;

function clipStoredBody(bodyText: string | undefined): string {
  const t = bodyText ?? '';
  if (t.length <= MAX_STORED_EMAIL_BODY_CHARS) return t;
  return (
    t.slice(0, MAX_STORED_EMAIL_BODY_CHARS) +
    '\n\n[Message body truncated at storage cap. Very large emails may be clipped.]'
  );
}

type MailSyncRow = {
  employee_id: string;
  start_date: string;
  last_processed_at: string | null;
  last_gmail_history_id: string | null;
  gmail_list_page_token: string | null;
  gmail_list_query_after_epoch: number | null;
  backfill_max_sent_at: string | null;
};

@Injectable()
export class EmailIngestionService {
  private readonly logger = new Logger(EmailIngestionService.name);
  private readonly relevanceModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null;

  /**
   * Set to `true` when a Gemini 429 indicates monthly quota / spend cap exhaustion.
   * Once set, inbound mail is not ingested (classification returns not relevant) until
   * the next cycle resets the flag after billing is restored.
   */
  private monthlyQuotaExhausted = false;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly employeesService: EmployeesService,
    private readonly gmailService: GmailService,
    private readonly oauthTokenService: OauthTokenService,
    private readonly conversationsService: ConversationsService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => DashboardService))
    private readonly dashboardService: DashboardService,
    private readonly companyPolicyService: CompanyPolicyService,
    private readonly aiEnrichmentService: AiEnrichmentService,
  ) {
    const key = getGeminiApiKeyFromEnv();
    if (!key) {
      this.relevanceModel = null;
      return;
    }
    const genAI = new GoogleGenerativeAI(key);
    const modelName =
      process.env.GEMINI_RELEVANCE_MODEL?.trim() || 'gemini-2.5-flash';
    this.relevanceModel = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    });
  }

  /**
   * Full multi-tenant cycle: every company with at least one active employee.
   * @param options.force Internal API only — run even when CEO turned mailbox crawl off.
   */
  async runIncrementalCycle(options?: { force?: boolean }): Promise<IngestionResult[]> {
    const pre = await this.settingsService.getAll();
    if (!pre.email_crawl_enabled && !options?.force) {
      this.logger.debug('Ingestion skipped — mailbox crawl disabled in settings');
      return [];
    }

    if (pre.email_ai_relevance_enabled && !this.relevanceModel) {
      this.logger.warn(
        'Inbox AI relevance is enabled in Settings but no Gemini API key is configured on the server. ' +
          'Set GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY). Until then, new mail is not stored unless the CEO confirms “import without Inbox AI” on My Email.',
      );
    }

    const acquired = await this.settingsService.tryAcquireIngestionLock();
    if (!acquired) {
      throw new ConflictException('Ingestion cycle is already running');
    }

    this.monthlyQuotaExhausted = false;
    this.aiEnrichmentService.resetMonthlyQuotaGate();

    const { data: companies, error: companiesErr } = await this.supabase.from('companies').select('id');
    if (companiesErr) {
      await this.settingsService.markIngestionFinished({
        status: 'failed',
        error: companiesErr.message,
        employees: 0,
        messages: 0,
      });
      throw companiesErr;
    }

    const companyIds = (companies ?? []).map((r) => (r as { id: string }).id);

    const { data: priorityRows } = await this.supabase
      .from('employees')
      .select('company_id')
      .eq('is_active', true)
      .eq('roster_duplicate', false)
      .eq('mailbox_type', 'SELF')
      .eq('gmail_status', 'CONNECTED')
      .is('last_synced_at', null);
    const neverSyncedCompanies = new Set(
      (priorityRows ?? []).map((r) => (r as { company_id: string }).company_id),
    );
    companyIds.sort((a, b) => {
      const aPri = neverSyncedCompanies.has(a) ? 0 : 1;
      const bPri = neverSyncedCompanies.has(b) ? 0 : 1;
      return aPri - bPri;
    });

    const results: IngestionResult[] = [];
    const cycleSettings = await this.settingsService.getAll();

    try {
      for (const companyId of companyIds) {
        const emailCrawlOn = await this.companyPolicyService.isEmailCrawlEnabledForCompany(companyId);
        if (!emailCrawlOn) {
          this.logger.debug(`Ingestion skipped for company ${companyId} (platform email crawl off)`);
          continue;
        }
        const employees = await this.employeesService.listActive(companyId);
        employees.sort((a, b) => {
          const aIsSelf = a.mailboxType === 'SELF' ? 0 : 1;
          const bIsSelf = b.mailboxType === 'SELF' ? 0 : 1;
          return aIsSelf - bIsSelf;
        });

        for (const employee of employees) {
          const hasOAuth = await this.oauthTokenService.hasToken(employee.id);
          if (!hasOAuth) {
            continue;
          }

          try {
            const result = await this.ingestForEmployee(companyId, employee, cycleSettings);
            results.push(result);
          } catch (err) {
            this.logger.error(
              `Ingestion failed for ${employee.name} (${employee.id})`,
              (err as Error).message,
            );
            results.push({
              companyId,
              employeeId: employee.id,
              employeeName: employee.name,
              newMessages: 0,
              skippedFiltered: 0,
              affectedThreads: 0,
              conversationsUpdated: 0,
              error: (err as Error).message,
            });
          }
        }

        if (cycleSettings.ai_enabled) {
          const aiOn = await this.companyPolicyService.isAiEnabledForCompany(companyId);
          if (aiOn) {
            void this.dashboardService
              .generateAiReport(companyId, { minCooldownMs: 3_600_000, scope: 'EXECUTIVE' })
              .catch((err) => {
                this.logger.warn(`Auto AI report failed for ${companyId}: ${(err as Error).message}`);
              });
          }
        }
      }

      await this.conversationsService.autoArchiveResolved();
      await this.repairConversationsWithMissingSummaries();

      await this.settingsService.markIngestionFinished({
        status: 'success',
        employees: results.length,
        messages: results.reduce((sum, r) => sum + r.newMessages, 0),
      });

      return results;
    } catch (err) {
      await this.settingsService.markIngestionFinished({
        status: 'failed',
        error: (err as Error).message,
        employees: results.length,
        messages: results.reduce((sum, r) => sum + r.newMessages, 0),
      });
      throw err;
    }
  }

  /**
   * Employee portal — "Run sync now" for **this** mailbox only (same `ingestForEmployee` path as cron).
   */
  async runIncrementalForSingleEmployee(companyId: string, employeeId: string): Promise<IngestionResult[]> {
    const pre = await this.settingsService.getAll();
    if (pre.email_ai_relevance_enabled && !this.relevanceModel) {
      this.logger.warn(
        'Inbox AI relevance is enabled in Settings but no Gemini API key is configured on the server.',
      );
    }

    this.monthlyQuotaExhausted = false;
    this.aiEnrichmentService.resetMonthlyQuotaGate();

    const emailCrawlOn = await this.companyPolicyService.isEmailCrawlEnabledForCompany(companyId);
    if (!emailCrawlOn) {
      this.logger.debug(`Single-mailbox ingest skipped for company ${companyId} (platform email crawl off)`);
      return [];
    }

    const em = await this.employeesService.getById(companyId, employeeId);
    if (!em || em.active === false) {
      throw new NotFoundException('Mailbox not found');
    }

    const hasOAuth = await this.oauthTokenService.hasToken(em.id);
    if (!hasOAuth) {
      return [
        {
          companyId,
          employeeId: em.id,
          employeeName: em.name,
          newMessages: 0,
          skippedFiltered: 0,
          affectedThreads: 0,
          conversationsUpdated: 0,
          error: 'Gmail not connected',
        },
      ];
    }

    const employee: Employee = {
      id: em.id,
      name: em.name,
      email: em.email,
      companyId: em.companyId,
      departmentId: em.departmentId,
      active: em.active,
      slaHoursDefault: em.slaHoursDefault,
      aiEnabled: em.aiEnabled,
      trackingStartAt: em.trackingStartAt ?? null,
      trackingPaused: em.trackingPaused,
    };

    const acquired = await this.settingsService.tryAcquireIngestionLock();
    if (!acquired) {
      throw new ConflictException('Ingestion cycle is already running');
    }

    const cycleSettings = await this.settingsService.getAll();
    const results: IngestionResult[] = [];

    try {
      try {
        const result = await this.ingestForEmployee(companyId, employee, cycleSettings);
        results.push(result);
      } catch (err) {
        this.logger.error(`Single-mailbox ingestion failed for ${employee.id}`, (err as Error).message);
        results.push({
          companyId,
          employeeId: employee.id,
          employeeName: employee.name,
          newMessages: 0,
          skippedFiltered: 0,
          affectedThreads: 0,
          conversationsUpdated: 0,
          error: (err as Error).message,
        });
      }

      await this.conversationsService.autoArchiveResolved();
      await this.repairConversationsWithMissingSummaries();

      await this.settingsService.markIngestionFinished({
        status: 'success',
        employees: results.length,
        messages: results.reduce((sum, r) => sum + r.newMessages, 0),
      });

      return results;
    } catch (err) {
      await this.settingsService.markIngestionFinished({
        status: 'failed',
        error: (err as Error).message,
        employees: results.length,
        messages: results.reduce((sum, r) => sum + r.newMessages, 0),
      });
      throw err;
    }
  }

  private async ingestForEmployee(
    companyId: string,
    employee: Employee,
    cycleSettings: SystemSettings,
  ): Promise<IngestionResult> {
    const tracking = await this.employeesService.getTrackingState(companyId, employee.id);
    if (tracking?.trackingPaused) {
      return {
        companyId,
        employeeId: employee.id,
        employeeName: employee.name,
        newMessages: 0,
        skippedFiltered: 0,
        affectedThreads: 0,
        conversationsUpdated: 0,
      };
    }
    if (!tracking?.trackingStartAt?.trim()) {
      this.logger.debug(`Ingest skipped (tracking_start_at not set): ${employee.name}`);
      return {
        companyId,
        employeeId: employee.id,
        employeeName: employee.name,
        newMessages: 0,
        skippedFiltered: 0,
        affectedThreads: 0,
        conversationsUpdated: 0,
      };
    }

    const portalLinked = await this.employeesService.hasPortalEmployeeLink(companyId, employee.id);
    const mailboxType = await this.employeesService.getMailboxType(employee.id);
    const isSelfMailbox = mailboxType === 'SELF';
    this.logger.log(
      `[ingest-debug] mailbox=${employee.email} id=${employee.id} type=${mailboxType} portalLinked=${portalLinked} trackingStart=${tracking.trackingStartAt ?? 'null'} paused=${tracking.trackingPaused === true}`,
    );

    // SELF mailboxes (CEO / manager My Email) must still ingest when global crawl is on.
    if (!isSelfMailbox && portalLinked && !cycleSettings.email_crawl_employee_mailboxes_enabled) {
      this.logger.debug(`Ingest skipped (employee-portal mailbox crawl off): ${employee.name}`);
      return {
        companyId,
        employeeId: employee.id,
        employeeName: employee.name,
        newMessages: 0,
        skippedFiltered: 0,
        affectedThreads: 0,
        conversationsUpdated: 0,
      };
    }
    if (!isSelfMailbox && !portalLinked && !cycleSettings.email_crawl_team_mailboxes_enabled) {
      this.logger.debug(`Ingest skipped (team mailbox crawl off): ${employee.name}`);
      return {
        companyId,
        employeeId: employee.id,
        employeeName: employee.name,
        newMessages: 0,
        skippedFiltered: 0,
        affectedThreads: 0,
        conversationsUpdated: 0,
      };
    }

    const syncState = await this.getSyncState(employee.id);
    const resumeToken = syncState?.gmail_list_page_token ?? null;
    const resumeEpoch = syncState?.gmail_list_query_after_epoch ?? null;

    const listAfterDate = this.liveListAfterDate(
      syncState,
      tracking.trackingStartAt,
      resumeToken,
      resumeEpoch,
    );

    const listQuery = buildGmailInboxListQuery(listAfterDate);
    const listMaxResults = Math.min(
      500,
      Math.max(
        50,
        Number(process.env.INGEST_GMAIL_LIST_MAX_RESULTS ?? String(GMAIL_LIST_PAGE_SIZE_DEFAULT)),
      ),
    );
    const maxListPages = Math.min(
      20,
      Math.max(
        1,
        Number(
          process.env.INGEST_GMAIL_MAX_LIST_PAGES_PER_RUN ?? String(GMAIL_LIST_MAX_PAGES_DEFAULT),
        ),
      ),
    );

    this.logger.log(
      `Fetching emails for ${employee.name} list after ${listAfterDate.toISOString()}${resumeToken ? ' (resuming list)' : ''}; up to ${maxListPages} pages × ${listMaxResults} ids/run`,
    );

    /**
     * When `gmail_list_page_token` is set, we continue a multi-run list walk. That walk does not
     * re-query page 1, so **brand-new** messages (always on the newest page) could be starved
     * until the entire backlog finished. Always merge a fresh first page when resuming.
     */
    const messageIds: string[] = [];
    const idSeen = new Set<string>();
    const pushIds = (ids: string[]) => {
      for (const id of ids) {
        if (!idSeen.has(id)) {
          idSeen.add(id);
          messageIds.push(id);
        }
      }
    };

    if (resumeToken) {
      const head = await this.gmailService.listMessageIdsPage(employee.id, listQuery, {
        maxResults: listMaxResults,
        pageToken: null,
      });
      pushIds(head.ids);
      this.logger.log(
        `List resume: prepended ${head.ids.length} id(s) from newest page before backlog token`,
      );
    }

    let pageTokenLoop: string | null = resumeToken;
    let nextPageToken: string | null = null;
    let pagesFetched = 0;
    for (let p = 0; p < maxListPages; p++) {
      const { ids, nextPageToken: np } = await this.gmailService.listMessageIdsPage(
        employee.id,
        listQuery,
        { maxResults: listMaxResults, pageToken: pageTokenLoop },
      );
      pushIds(ids);
      nextPageToken = np;
      pagesFetched = p + 1;
      if (!np) {
        nextPageToken = null;
        break;
      }
      pageTokenLoop = np;
    }
    this.logger.log(
      `[ingest-debug] gmail-list mailbox=${employee.email} ids=${messageIds.length} pages=${pagesFetched} hasNext=${nextPageToken ? 'yes' : 'no'} resumed=${resumeToken ? 'yes' : 'no'} queryAfter=${listAfterDate.toISOString()}`,
    );

    if (messageIds.length === 0 && !nextPageToken) {
      /**
       * Safety fallback: Gmail indexing / cursor timing can occasionally return no IDs
       * right after recent messages arrive. Probe a short recent window before declaring
       * "no new messages" so user-facing inboxes don't appear stuck at zero.
       */
      const fallbackQuery = `${buildGmailInboxListQuery(null)} newer_than:7d`;
      const fallback = await this.gmailService.listMessageIdsPage(employee.id, fallbackQuery, {
        maxResults: Math.min(120, listMaxResults),
        pageToken: null,
      });
      pushIds(fallback.ids);
      if (fallback.ids.length > 0) {
        this.logger.log(
          `Zero-id cursor fallback recovered ${fallback.ids.length} recent message(s) for ${employee.name}`,
        );
      } else {
        this.logger.log(`No new messages for ${employee.name}`);
        await this.persistMailSyncState(employee.id, syncState, {
          lastProcessedAt: new Date(),
          clearListProgress: true,
        });
        /** Same as a full batch: run completed — record per-mailbox sync time (was missing; UI showed a false “no sync” warning). */
        await this.supabase
          .from('employees')
          .update({
            last_synced_at: new Date().toISOString(),
            gmail_status: 'CONNECTED',
          })
          .eq('id', employee.id)
          .eq('company_id', companyId);
        return {
          companyId,
          employeeId: employee.id,
          employeeName: employee.name,
          newMessages: 0,
          skippedFiltered: 0,
          affectedThreads: 0,
          conversationsUpdated: 0,
        };
      }
    }

    const companyAiOn = await this.companyPolicyService.isAiEnabledForCompany(companyId);
    const allowGeminiRelevance =
      Boolean(this.relevanceModel) &&
      companyAiOn &&
      cycleSettings.email_ai_relevance_enabled &&
      employee.aiEnabled !== false;

    const ingestWithoutAiConfirmed = cycleSettings.email_ingest_without_ai_confirmed;

    /** Cache Gmail `threads.get` metadata per thread for one employee batch (sibling fetches). */
    const threadMetaCache = new Map<string, gmail_v1.Schema$Message[]>();

    /** Only Gemini-classified mail is stored, or all mail in-window after CEO confirms import without Inbox AI. */
    const messages: EmailMessage[] = [];
    const affectedThreads = new Set<string>();
    let skippedFiltered = 0;
    let skippedFromExistingBeforeTracking = 0;
    let retriedFromAiSkip = 0;
    let skippedFromExistingUnknown = 0;
    let skippedBeforeTrackingWindow = 0;
    let skippedByAiDecision = 0;
    let batchLatestSent: Date | null = null;

    for (const msgId of messageIds) {
      if (await this.messageInDatabase(employee.id, msgId)) continue;

      const skipKind = await this.getRecordedSkipKind(employee.id, msgId);
      if (skipKind) {
        const outboundPeek = await this.gmailService.peekIsOutboundFrom(
          employee.id,
          employee.email,
          msgId,
        );
        if (outboundPeek) {
          await this.clearIngestionSkip(employee.id, msgId);
        } else if (skipKind === 'ai_irrelevant') {
          /**
           * Re-evaluate previously AI-skipped inbound messages with the latest classifier/guardrails.
           * Without this, historical false negatives stay hidden forever unless manually cleared.
           */
          await this.clearIngestionSkip(employee.id, msgId);
          retriedFromAiSkip += 1;
        } else {
          if (skipKind === 'before_tracking') skippedFromExistingBeforeTracking += 1;
          else skippedFromExistingUnknown += 1;
          continue;
        }
      }

      try {
        const msg = await this.gmailService.fetchFullMessage(employee.id, employee.email, msgId);

        if (!batchLatestSent || msg.sentAt > batchLatestSent) {
          batchLatestSent = msg.sentAt;
        }

        const startAt = new Date(tracking.trackingStartAt);
        if (msg.sentAt < startAt) {
          skippedFiltered += 1;
          skippedBeforeTrackingWindow += 1;
          await this.recordIngestionSkip(employee.id, msg.providerMessageId, {
            skip_kind: 'before_tracking',
            skip_reason: 'Sent before your tracking start time.',
            subject: msg.subject,
            from_email: msg.fromEmail,
            sent_at: msg.sentAt,
            provider_thread_id: msg.providerThreadId,
          });
          continue;
        }

        let threadSlice: EmailMessage[] = [msg];
        if (allowGeminiRelevance && this.relevanceModel) {
          threadSlice = await this.gmailService.fetchLastMessagesInThreadForRelevance(
            employee.id,
            employee.email,
            msg,
            threadMetaCache,
            3,
          );
        }

        const decision = await this.classifyMessageForIngest(
          msg,
          threadSlice,
          employee.email,
          this.gmailService.isNoise(msg.labelIds),
          allowGeminiRelevance,
          ingestWithoutAiConfirmed,
        );
        if (!decision.relevant) {
          skippedFiltered += 1;
          skippedByAiDecision += 1;
          const reasonText =
            decision.reason?.trim() ||
            (allowGeminiRelevance && this.relevanceModel
              ? 'Marked not relevant by Inbox AI.'
              : 'Not ingested without a positive Inbox AI decision.');
          await this.recordIngestionSkip(employee.id, msg.providerMessageId, {
            skip_kind: 'ai_irrelevant',
            skip_reason: reasonText,
            subject: msg.subject,
            from_email: msg.fromEmail,
            sent_at: msg.sentAt,
            provider_thread_id: msg.providerThreadId,
          });
          continue;
        }

        if (decision.reason) {
          msg.relevanceReason = decision.reason;
        }

        messages.push(msg);
        affectedThreads.add(msg.providerThreadId);
        threadMetaCache.delete(msg.providerThreadId);
      } catch (err) {
        this.logger.warn(`Failed to fetch message ${msgId}: ${(err as Error).message}`);
      }
    }
    this.logger.log(
      `[ingest-debug] decision mailbox=${employee.email} considered=${messageIds.length} stored=${messages.length} skipped=${skippedFiltered} affectedThreads=${affectedThreads.size}`,
    );

    if (messages.length > 0) {
      await this.storeMessages(companyId, employee.id, messages);
    }

    let conversationsUpdated = 0;
    if (affectedThreads.size > 0) {
      const threadKeys = [...affectedThreads].map((threadId) => ({
        companyId,
        employeeId: employee.id,
        threadId,
      }));
      const recomputeResult = await this.conversationsService.recomputeForThreads(threadKeys);
      conversationsUpdated = recomputeResult.threadsProcessed;
    }

    const listEpochSec = Math.floor(listAfterDate.getTime() / 1000);
    const mergedHighWater = this.mergeSentHighWater(
      syncState?.backfill_max_sent_at,
      batchLatestSent,
    );

    if (nextPageToken) {
      await this.persistMailSyncState(employee.id, syncState, {
        gmailListPageToken: nextPageToken,
        gmailListQueryAfterEpoch: listEpochSec,
        backfillMaxSentAt: mergedHighWater,
      });
    } else {
      const cursor = mergedHighWater ?? new Date();
      await this.persistMailSyncState(employee.id, syncState, {
        lastProcessedAt: cursor,
        clearListProgress: true,
      });
    }
    await this.supabase
      .from('employees')
      .update({
        last_synced_at: new Date().toISOString(),
        gmail_status: 'CONNECTED',
      })
      .eq('id', employee.id)
      .eq('company_id', companyId);

    this.logger.log(
      `Stored ${messages.length} portal messages, ${skippedFiltered} skipped (window/relevance; gemini=${allowGeminiRelevance}; unfiltered_ok=${ingestWithoutAiConfirmed}) for ${employee.name}`,
    );

    return {
      companyId,
      employeeId: employee.id,
      employeeName: employee.name,
      newMessages: messages.length,
      skippedFiltered,
      affectedThreads: affectedThreads.size,
      conversationsUpdated,
    };
  }

  /**
   * Repair: recompute any conversation whose summary is still blank or too short.
   * AI enrichment is ENABLED so Gemini can write real summaries and set correct priority.
   */
  private async repairConversationsWithMissingSummaries(): Promise<void> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('conversation_id, employee_id, provider_thread_id, company_id, summary')
      .eq('is_ignored', false)
      .or('summary.eq.,summary.is.null');

    if (error || !data || data.length === 0) {
      if (data?.length === 0) this.logger.debug('No conversations need summary repair');
      if (error) this.logger.warn(`repairConversationsWithMissingSummaries: ${error.message}`);
      return;
    }

    this.logger.log(`Repairing ${data.length} conversations with empty summary — AI enrichment enabled`);
    const keys: { companyId: string; employeeId: string; threadId: string }[] =
      (data as { conversation_id: string; employee_id: string; provider_thread_id: string; company_id: string }[])
        .map((r) => ({
          companyId: r.company_id,
          employeeId: r.employee_id,
          threadId: r.provider_thread_id,
        }));

    await this.conversationsService.recomputeForThreads(keys);
  }

  /** Sort thread slice oldest → newest for classification input. */
  private sortThreadChronological(slice: EmailMessage[]): EmailMessage[] {
    return [...slice].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  /**
   * Gemini classify with retries (aligned with enrichment): transient errors + 429 with retry-after style wait.
   */
  private async callGeminiIngestRelevance(prompt: string, fromEmail: string): Promise<{
    relevant: boolean;
    reason: string | null;
  } | null> {
    if (!this.relevanceModel) return null;

    if (this.monthlyQuotaExhausted) {
      return null;
    }

    const retries = 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.relevanceModel.generateContent(prompt);
        const text = result.response.text().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(text) as { relevant?: boolean; reason?: string };
        if (typeof parsed.relevant === 'boolean') {
          const reason =
            typeof parsed.reason === 'string' && parsed.reason.trim()
              ? parsed.reason.trim().slice(0, 500)
              : null;
          this.logger.debug(`AI relevance for ${fromEmail}: ${parsed.relevant} — ${reason ?? ''}`);
          return { relevant: parsed.relevant, reason };
        }
        this.logger.warn(`AI relevance JSON parse: missing relevant flag for ${fromEmail}`);
        return null;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        const is429 = /\b429\b|quota|Quota|rate|Rate|resource_exhausted/i.test(msg);
        const isMonthly = /monthly|exceeded its|spending\s+cap|spend\s+cap/i.test(msg);

        if (is429 && isMonthly) {
          this.monthlyQuotaExhausted = true;
          this.logger.error(
            `Gemini monthly quota or spend cap exhausted — inbound ingestion paused for this cycle. ${msg.slice(0, 200)}`,
          );
          return null;
        }

        if (is429 && attempt < retries) {
          const secMatch = msg.match(/retry in (\d+(\.\d+)?)\s*s/i);
          const msMatch = !secMatch ? msg.match(/retry in (\d+(\.\d+)?)\s*ms/i) : null;
          let waitSec = secMatch ? Math.ceil(Number(secMatch[1])) : msMatch ? Math.ceil(Number(msMatch[1]) / 1000) : 45;
          waitSec = Math.max(1, Math.min(waitSec, 120));
          this.logger.warn(
            `Gemini inbox relevance rate limit — retry ${attempt + 1}/${retries} in ${waitSec}s: ${msg.slice(0, 160)}`,
          );
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        if (attempt < retries && !is429) {
          const backoff = 400 * Math.pow(2, attempt);
          this.logger.warn(
            `Gemini inbox relevance failed (attempt ${attempt + 1}/${retries}) — retry in ${backoff}ms: ${msg.slice(0, 200)}`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        this.logger.warn(`Gemini inbox relevance failed after retries for ${fromEmail}: ${msg.slice(0, 200)}`);
        return null;
      }
    }
    return null;
  }

  private async classifyMessageForIngest(
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
      const prompt = buildSharedIngestRelevancePrompt(target, sliceWithTarget, employeeEmail, hasNoiseGmailLabel);
      const parsed = await this.callGeminiIngestRelevance(prompt, target.fromEmail);
      if (parsed) {
        if (!parsed.relevant && this.looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel)) {
          return {
            relevant: true,
            reason:
              'Safety override: direct human mailbox message kept even though Inbox AI marked it not relevant.',
          };
        }
        return { relevant: parsed.relevant, reason: parsed.reason };
      }
      if (this.monthlyQuotaExhausted && !ingestWithoutAiConfirmed) {
        return {
          relevant: false,
          reason:
            'Inbox AI unavailable: Gemini monthly quota or spend cap exceeded. Inbound messages are not ingested until billing is restored.',
        };
      }
      return { relevant: ingestWithoutAiConfirmed, reason: null };
    }

    if (ingestWithoutAiConfirmed) {
      return {
        relevant: true,
        reason: 'Unfiltered import — Inbox AI unavailable; CEO confirmed on My Email.',
      };
    }
    return { relevant: false, reason: null };
  }

  /**
   * Guardrail for false negatives: if Inbox AI says "irrelevant" but this looks like
   * a direct human thread to the tracked mailbox, keep it in the portal.
   */
  private looksLikeDirectHumanMail(
    target: EmailMessage,
    employeeEmail: string,
    hasNoiseGmailLabel: boolean,
  ): boolean {
    if (target.direction !== 'INBOUND') return false;
    if (hasNoiseGmailLabel) return false;

    const norm = (v: string) => v.trim().toLowerCase();
    const mailbox = norm(employeeEmail);
    const to = (target.toEmails ?? []).map(norm).filter(Boolean);
    const cc = (target.ccEmails ?? []).map(norm).filter(Boolean);
    const recipients = new Set([...to, ...cc]);
    const isDirectToMailbox = to.includes(mailbox) || cc.includes(mailbox);
    const isSmallAudience = recipients.size <= 8;

    const from = norm(target.fromEmail ?? '');
    const subject = (target.subject ?? '').toLowerCase();
    const body = (target.bodyText ?? '').slice(0, 2000).toLowerCase();

    const automatedSender =
      /(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster)/i.test(from);
    const obviousBroadcastSubject =
      /(newsletter|digest|unsubscribe|promo|promotion|campaign|webinar|view in browser)/i.test(subject);
    const obviousBroadcastBody =
      /(unsubscribe|manage preferences|view in browser|email preferences)/i.test(body);

    if (!isDirectToMailbox || !isSmallAudience) return false;
    if (automatedSender || obviousBroadcastSubject || obviousBroadcastBody) return false;
    return true;
  }

  private async messageInDatabase(employeeId: string, providerMessageId: string): Promise<boolean> {
    const { data: row } = await this.supabase
      .from('email_messages')
      .select('provider_message_id')
      .eq('employee_id', employeeId)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    return row != null;
  }

  private async getRecordedSkipKind(
    employeeId: string,
    providerMessageId: string,
  ): Promise<'before_tracking' | 'ai_irrelevant' | 'legacy' | null> {
    const { data: sk } = await this.supabase
      .from('email_ingestion_skips')
      .select('provider_message_id, skip_kind')
      .eq('employee_id', employeeId)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    if (!sk) return null;
    const kind = String((sk as { skip_kind?: string | null }).skip_kind ?? '').trim().toLowerCase();
    if (kind === 'before_tracking' || kind === 'ai_irrelevant' || kind === 'legacy') {
      return kind;
    }
    return 'legacy';
  }

  private async clearIngestionSkip(employeeId: string, providerMessageId: string): Promise<void> {
    const { error } = await this.supabase
      .from('email_ingestion_skips')
      .delete()
      .eq('employee_id', employeeId)
      .eq('provider_message_id', providerMessageId);
    if (error) {
      this.logger.warn(`clearIngestionSkip ${providerMessageId}: ${error.message}`);
    }
  }

  private async messageAlreadyHandled(
    employeeId: string,
    providerMessageId: string,
  ): Promise<boolean> {
    if (await this.messageInDatabase(employeeId, providerMessageId)) return true;
    return (await this.getRecordedSkipKind(employeeId, providerMessageId)) != null;
  }

  /** Persist skip ledger row (live sync, historical fetch, etc.). */
  async recordIngestionSkip(
    employeeId: string,
    providerMessageId: string,
    meta?: {
      skip_kind: 'before_tracking' | 'ai_irrelevant' | 'legacy';
      skip_reason?: string | null;
      subject?: string;
      from_email?: string;
      sent_at?: Date | null;
      provider_thread_id?: string;
    },
  ): Promise<void> {
    const row: Record<string, unknown> = {
      employee_id: employeeId,
      provider_message_id: providerMessageId,
      skipped_at: new Date().toISOString(),
    };
    if (meta) {
      row.skip_kind = meta.skip_kind;
      row.skip_reason = meta.skip_reason?.trim() ? meta.skip_reason.trim().slice(0, 2000) : null;
      row.subject = meta.subject?.trim() ? meta.subject.trim().slice(0, 500) : null;
      row.from_email = meta.from_email?.trim() ? meta.from_email.trim().slice(0, 320) : null;
      row.sent_at = meta.sent_at ? meta.sent_at.toISOString() : null;
      row.provider_thread_id = meta.provider_thread_id?.trim()
        ? meta.provider_thread_id.trim().slice(0, 200)
        : null;
    } else {
      row.skip_kind = 'legacy';
    }
    const { error } = await this.supabase.from('email_ingestion_skips').upsert(row, {
      onConflict: 'employee_id,provider_message_id',
    });
    if (error) {
      this.logger.error(`recordIngestionSkip ${providerMessageId}: ${error.message}`);
      throw error;
    }
  }

  /** Remove skip ledger entry so the next Gmail sync can fetch and re-classify this message. */
  async clearIngestionSkipEntry(employeeId: string, providerMessageId: string): Promise<void> {
    await this.clearIngestionSkip(employeeId, providerMessageId);
  }

  /**
   * CEO / user override: import one Gmail message into the portal immediately, bypassing Inbox AI relevance.
   * Clears any skip row, fetches the message, stores it, and recomputes the thread conversation.
   */
  async forceImportSkippedMessage(
    companyId: string,
    employeeId: string,
    providerMessageId: string,
  ): Promise<{ outcome: 'imported' | 'already_in_portal'; conversationsUpdated: number }> {
    const employee = await this.employeesService.getById(companyId, employeeId);
    if (!employee) {
      throw new NotFoundException('Mailbox not found');
    }
    if (!(await this.oauthTokenService.hasToken(employeeId))) {
      throw new BadRequestException('Gmail is not connected for this mailbox');
    }

    const tracking = await this.employeesService.getTrackingState(companyId, employeeId);
    if (!tracking?.trackingStartAt?.trim()) {
      throw new BadRequestException('Set a tracking start time on Live mail before importing');
    }
    if (tracking.trackingPaused) {
      throw new BadRequestException('Mailbox tracking is paused');
    }

    if (await this.messageInDatabase(employeeId, providerMessageId)) {
      await this.clearIngestionSkip(employeeId, providerMessageId);
      return { outcome: 'already_in_portal', conversationsUpdated: 0 };
    }

    await this.clearIngestionSkip(employeeId, providerMessageId);

    let msg: EmailMessage;
    try {
      msg = await this.gmailService.fetchFullMessage(employee.id, employee.email, providerMessageId);
    } catch (e) {
      throw new BadRequestException(
        `Could not load this message from Gmail: ${(e as Error).message}`,
      );
    }

    const startAt = new Date(tracking.trackingStartAt);
    if (msg.sentAt < startAt) {
      throw new BadRequestException(
        'This message is before your tracking start — move “Track live mail from” earlier, or pick a different message.',
      );
    }

    msg.relevanceReason =
      'Marked important by you — imported from the AI-skipped list (Inbox AI override).';

    await this.storeMessages(companyId, employeeId, [msg]);

    const recompute = await this.conversationsService.recomputeForThreads([
      { companyId, employeeId, threadId: msg.providerThreadId },
    ]);

    await this.supabase
      .from('employees')
      .update({
        last_synced_at: new Date().toISOString(),
        gmail_status: 'CONNECTED',
      })
      .eq('id', employee.id)
      .eq('company_id', companyId);

    this.logger.log(
      `forceImportSkippedMessage: imported ${providerMessageId} for ${employee.email} (override), threads=${recompute.threadsProcessed}`,
    );

    return {
      outcome: 'imported',
      conversationsUpdated: recompute.threadsProcessed,
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

    if (error && this.isMissingCcEmailsColumn(error)) {
      const legacyRows = rows.map(({ cc_emails: _cc, ...rest }) => rest);
      const second = await this.supabase
        .from('email_messages')
        .upsert(legacyRows, { onConflict: 'provider_message_id' });
      if (!second.error) {
        this.logger.warn(
          'email_messages.cc_emails column missing — applied legacy upsert; run migration 019_cc_emails_user_cc_only.sql.',
        );
        return;
      }
      error = second.error;
    }

    if (error && this.isMissingRelevanceReasonColumn(error)) {
      const legacyRows = rows.map(({ relevance_reason: _rr, cc_emails: _cc, ...rest }) => rest);
      const second = await this.supabase
        .from('email_messages')
        .upsert(legacyRows, { onConflict: 'provider_message_id' });
      if (!second.error) {
        this.logger.warn(
          'email_messages.relevance_reason column missing — applied legacy upsert; run migration 018_email_messages_relevance_reason.sql.',
        );
        return;
      }
      error = second.error;
    }

    if (error && this.isMissingSenderIdentityColumns(error)) {
      const legacyRows = rows.map(
        ({ from_name: _n, reply_to_email: _r, relevance_reason: _rr, cc_emails: _cc, ...rest }) => rest,
      );
      const { error: legacyErr } = await this.supabase
        .from('email_messages')
        .upsert(legacyRows, { onConflict: 'provider_message_id' });
      if (!legacyErr) {
        this.logger.warn(
          'email_messages.from_name/reply_to_email columns are missing. Applied legacy insert fallback; run migration 017_sender_identity_enrichment.sql.',
        );
        return;
      }
      this.logger.error('Failed to store messages (legacy fallback)', legacyErr.message);
      throw legacyErr;
    }

    if (error) {
      this.logger.error('Failed to store messages', error.message);
      throw error;
    }
  }

  private isMissingSenderIdentityColumns(err: { code?: string; message?: string }): boolean {
    const msg = String(err?.message ?? '');
    const code = String(err?.code ?? '');
    return (
      code === '42703' ||
      msg.includes('from_name') ||
      msg.includes('reply_to_email')
    );
  }

  private isMissingRelevanceReasonColumn(err: { code?: string; message?: string }): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('relevance_reason');
  }

  private isMissingCcEmailsColumn(err: { code?: string; message?: string }): boolean {
    const msg = String(err?.message ?? '');
    return msg.includes('cc_emails');
  }

  /**
   * Live Gmail `messages.list` lower bound for `after:` (resume token + epoch win while paginating).
   *
   * **Bug without overlap:** Using max(tracking_start, last_processed) as `after:` means the next run
   * only lists mail *newer than* `last_processed`. Any message *older* than that instant that was never
   * stored (Gemini skip, fetch error, or arrived in a race) never matches the query again — e.g. a 2:59 PM
   * test mail after a sync that advanced the cursor to 3:01 PM.
   *
   * **Fix:** Roll `after:` back by `INGEST_GMAIL_LIST_AFTER_OVERLAP_HOURS` (default 48) from
   * `last_processed` so recent stragglers reappear; `messageInDatabase` / skip rows dedupe.
   * Set overlap to `0` to restore the legacy tight cursor (not recommended).
   */
  private liveListAfterDate(
    syncState: MailSyncRow | null,
    trackingStartIso: string | null | undefined,
    resumeToken: string | null,
    resumeEpoch: number | null,
  ): Date {
    if (resumeToken != null && resumeEpoch != null) {
      return new Date(Number(resumeEpoch) * 1000);
    }

    const productStartMs = trackingStartIso?.trim()
      ? new Date(trackingStartIso.trim()).getTime()
      : Date.now();

    const lastProcessedRaw = syncState?.last_processed_at?.trim();
    const lastProcessedMs = lastProcessedRaw ? new Date(lastProcessedRaw).getTime() : null;

    const hoursRaw = Number(process.env.INGEST_GMAIL_LIST_AFTER_OVERLAP_HOURS ?? '48');
    const overlapHours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 0), 168) : 48;
    const overlapMs = overlapHours * 60 * 60 * 1000;

    if (lastProcessedMs != null && overlapMs > 0) {
      return new Date(Math.max(productStartMs, lastProcessedMs - overlapMs));
    }

    if (lastProcessedMs != null) {
      return new Date(Math.max(productStartMs, lastProcessedMs));
    }

    return new Date(productStartMs);
  }

  private async getSyncState(employeeId: string): Promise<MailSyncRow | null> {
    const { data } = await this.supabase
      .from('mail_sync_state')
      .select('*')
      .eq('employee_id', employeeId)
      .maybeSingle();

    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      employee_id: row.employee_id as string,
      start_date: row.start_date as string,
      last_processed_at: (row.last_processed_at as string | null) ?? null,
      last_gmail_history_id: (row.last_gmail_history_id as string | null) ?? null,
      gmail_list_page_token: (row.gmail_list_page_token as string | null) ?? null,
      gmail_list_query_after_epoch:
        row.gmail_list_query_after_epoch != null
          ? Number(row.gmail_list_query_after_epoch)
          : null,
      backfill_max_sent_at: (row.backfill_max_sent_at as string | null) ?? null,
    };
  }

  /**
   * Diagnostic: run Gmail `messages.list` with the same cursor/query as incremental ingest would use,
   * without writing to the DB or advancing `mail_sync_state`. Optionally list IDs for a historical window.
   */
  async probeGmailFetch(
    companyId: string,
    employeeId: string,
    options?: {
      maxPages?: number;
      historicalRange?: { startIso: string; endIso: string };
    },
  ): Promise<MailFetchProbeResult> {
    const employee = await this.employeesService.getById(companyId, employeeId);
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    const hasOAuth = await this.oauthTokenService.hasToken(employeeId);
    const tracking = await this.employeesService.getTrackingState(companyId, employeeId);
    const syncState = await this.getSyncState(employeeId);

    const resumeToken = syncState?.gmail_list_page_token ?? null;
    const resumeEpoch = syncState?.gmail_list_query_after_epoch ?? null;

    const listAfterDate = this.liveListAfterDate(
      syncState,
      tracking?.trackingStartAt,
      resumeToken,
      resumeEpoch,
    );

    const listQuery = buildGmailInboxListQuery(listAfterDate);
    const maxPages = Math.min(10, Math.max(1, options?.maxPages ?? 5));
    const maxResults = 200;

    let messageIds: string[] = [];
    let pageTokenLoop: string | null = resumeToken;
    let nextPageToken: string | null = null;
    let pagesFetched = 0;
    let liveGmailError: string | null = null;

    try {
      for (let p = 0; p < maxPages; p++) {
        const { ids, nextPageToken: np } = await this.gmailService.listMessageIdsPage(
          employeeId,
          listQuery,
          { maxResults, pageToken: pageTokenLoop },
        );
        messageIds.push(...ids);
        nextPageToken = np ?? null;
        pagesFetched = p + 1;
        pageTokenLoop = np ?? null;
        if (!np) break;
      }
    } catch (err) {
      liveGmailError = (err as Error).message ?? String(err);
    }

    const { count: totalStored } = await this.supabase
      .from('email_messages')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('employee_id', employeeId);

    const notes: string[] = [];
    if (!hasOAuth) {
      notes.push('No Gmail OAuth token for this mailbox — connect Gmail first.');
    }
    if (liveGmailError) {
      notes.push(`Live list Gmail API error: ${liveGmailError}`);
    } else if (messageIds.length === 0 && !nextPageToken) {
      notes.push(
        'Gmail returned zero message IDs for the live incremental query (inbox + sent, minus spam/promotions/etc.). New mail may still arrive later.',
      );
    } else {
      notes.push(
        `Live query: Gmail returned ${messageIds.length} message id(s) in ${pagesFetched} list page(s)${
          nextPageToken ? '; more pages exist (ingestion continues on the next run)' : ''
        }.`,
      );
    }
    notes.push(`Stored rows in email_messages for this mailbox: ${totalStored ?? 0}.`);

    let historical:
      | MailFetchProbeResult['historical']
      | undefined;
    const hr = options?.historicalRange;
    if (hr?.startIso?.trim() && hr?.endIso?.trim()) {
      const startMs = Date.parse(hr.startIso.trim());
      const endMs = Date.parse(hr.endIso.trim());
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        const hQuery = buildGmailHistoricalWindowQuery(new Date(startMs), new Date(endMs));
        let hIds: string[] = [];
        let hNext: string | null = null;
        let hPages = 0;
        let hErr: string | null = null;
        try {
          let pt: string | null = null;
          for (let p = 0; p < maxPages; p++) {
            const { ids, nextPageToken: np } = await this.gmailService.listMessageIdsPage(
              employeeId,
              hQuery,
              { maxResults, pageToken: pt },
            );
            hIds.push(...ids);
            hNext = np ?? null;
            hPages = p + 1;
            pt = np ?? null;
            if (!np) break;
          }
        } catch (err) {
          hErr = (err as Error).message ?? String(err);
        }
        historical = {
          start_iso: new Date(startMs).toISOString(),
          end_iso: new Date(endMs).toISOString(),
          list_query: hQuery,
          pages_fetched: hPages,
          message_ids_counted: hIds.length,
          has_more_list_pages: Boolean(hNext),
          gmail_error: hErr,
        };
        if (hErr) {
          notes.push(`Historical window list error: ${hErr}`);
        } else {
          notes.push(
            `Historical window: Gmail listed ${hIds.length} message id(s) in ${hPages} page(s) for the selected dates (cap ${maxPages} pages per probe).`,
          );
        }
      }
    }

    const ok =
      hasOAuth &&
      !liveGmailError &&
      (historical === undefined || !historical.gmail_error);

    return {
      ok,
      employee_id: employeeId,
      employee_email: employee.email,
      employee_name: employee.name,
      oauth_configured: hasOAuth,
      live: {
        list_after_iso: listAfterDate.toISOString(),
        list_query: listQuery,
        resuming_paged_list: resumeToken != null,
        pages_fetched: pagesFetched,
        message_ids_counted: messageIds.length,
        has_more_list_pages: Boolean(nextPageToken),
        gmail_error: liveGmailError,
      },
      historical,
      database: {
        total_email_messages_stored: totalStored ?? 0,
      },
      notes,
    };
  }

  private mergeSentHighWater(
    prevIso: string | null | undefined,
    batchLatest: Date | null,
  ): Date | null {
    let ms = -Infinity;
    if (prevIso) ms = Math.max(ms, new Date(prevIso).getTime());
    if (batchLatest) ms = Math.max(ms, batchLatest.getTime());
    if (!Number.isFinite(ms) || ms === -Infinity) return null;
    return new Date(ms);
  }

  private async persistMailSyncState(
    employeeId: string,
    existing: MailSyncRow | null,
    patch: {
      lastProcessedAt?: Date;
      clearListProgress?: boolean;
      gmailListPageToken?: string | null;
      gmailListQueryAfterEpoch?: number | null;
      backfillMaxSentAt?: Date | null;
    },
  ): Promise<void> {
    let startDate = existing?.start_date;
    if (!startDate) {
      const { data: emp } = await this.supabase
        .from('employees')
        .select('tracking_start_at')
        .eq('id', employeeId)
        .maybeSingle();
      const ts = (emp as { tracking_start_at: string | null } | null)?.tracking_start_at;
      startDate =
        ts && ts.trim()
          ? new Date(ts.trim()).toISOString()
          : new Date().toISOString();
    }
    let lastProcessed = existing?.last_processed_at ?? null;
    if (patch.lastProcessedAt) {
      lastProcessed = patch.lastProcessedAt.toISOString();
    }

    let pageToken = existing?.gmail_list_page_token ?? null;
    let afterEpoch = existing?.gmail_list_query_after_epoch ?? null;
    let backfillMax = existing?.backfill_max_sent_at ?? null;

    if (patch.clearListProgress) {
      pageToken = null;
      afterEpoch = null;
      backfillMax = null;
    } else {
      if (patch.gmailListPageToken !== undefined) pageToken = patch.gmailListPageToken;
      if (patch.gmailListQueryAfterEpoch !== undefined) afterEpoch = patch.gmailListQueryAfterEpoch;
      if (patch.backfillMaxSentAt !== undefined) {
        backfillMax = patch.backfillMaxSentAt
          ? patch.backfillMaxSentAt.toISOString()
          : null;
      }
    }

    const row: Record<string, unknown> = {
      employee_id: employeeId,
      start_date: startDate,
      last_processed_at: lastProcessed,
      last_gmail_history_id: existing?.last_gmail_history_id ?? null,
      updated_at: new Date().toISOString(),
      gmail_list_page_token: pageToken,
      gmail_list_query_after_epoch: afterEpoch,
      backfill_max_sent_at: backfillMax,
    };

    const { error } = await this.supabase.from('mail_sync_state').upsert(row, {
      onConflict: 'employee_id',
    });

    if (error) {
      this.logger.error(`Failed to update sync state for ${employeeId}`, error.message);
    }
  }
}
