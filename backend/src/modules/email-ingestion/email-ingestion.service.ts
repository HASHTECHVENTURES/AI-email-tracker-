import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { Employee, EmailMessage } from '../common/types';
import { EmployeesService } from '../employees/employees.service';
import { ConversationsService } from '../conversations/conversations.service';
import { SettingsService, type SystemSettings } from '../settings/settings.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { GmailService } from './gmail.service';
import { isRelevantEmail } from './email-filter.util';
import { OauthTokenService } from '../auth/oauth-token.service';

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

@Injectable()
export class EmailIngestionService {
  private readonly logger = new Logger(EmailIngestionService.name);
  private readonly relevanceModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly employeesService: EmployeesService,
    private readonly gmailService: GmailService,
    private readonly oauthTokenService: OauthTokenService,
    private readonly conversationsService: ConversationsService,
    private readonly settingsService: SettingsService,
    private readonly dashboardService: DashboardService,
  ) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      this.relevanceModel = null;
      return;
    }
    const genAI = new GoogleGenerativeAI(key);
    this.relevanceModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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

    const acquired = await this.settingsService.tryAcquireIngestionLock();
    if (!acquired) {
      throw new ConflictException('Ingestion cycle is already running');
    }

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

    const results: IngestionResult[] = [];
    const cycleSettings = await this.settingsService.getAll();

    try {
      for (const row of companies ?? []) {
        const companyId = (row as { id: string }).id;
        const employees = await this.employeesService.listActive(companyId);

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
          this.dashboardService
            .generateAiReport(companyId, { minCooldownMs: 3_600_000, scope: 'EXECUTIVE' })
            .catch((err) => {
              this.logger.warn(`Auto AI report failed for ${companyId}: ${(err as Error).message}`);
            });
        }
      }

      await this.conversationsService.autoArchiveResolved();

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

    const portalLinked = await this.employeesService.hasPortalEmployeeLink(companyId, employee.id);
    if (portalLinked && !cycleSettings.email_crawl_employee_mailboxes_enabled) {
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
    if (!portalLinked && !cycleSettings.email_crawl_team_mailboxes_enabled) {
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
    const afterDate = this.effectiveAfterDate(
      syncState?.last_processed_at,
      syncState?.start_date,
    );

    this.logger.log(
      `Fetching emails for ${employee.name} after ${afterDate?.toISOString() ?? 'beginning'}`,
    );

    const messageIds = await this.gmailService.fetchNewMessageIds(employee.id, afterDate, 20);

    if (messageIds.length === 0) {
      this.logger.log(`No new messages for ${employee.name}`);
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

    const excludePatterns = await this.getExcludePatterns(employee.id);
    const messages: EmailMessage[] = [];
    const relevantMessages: EmailMessage[] = [];
    const affectedThreads = new Set<string>();
    let skippedFiltered = 0;

    for (const msgId of messageIds) {
      const alreadyExists = await this.messageExists(msgId);
      if (alreadyExists) continue;

      try {
        const msg = await this.gmailService.fetchFullMessage(employee.id, employee.email, msgId);

        const startAt = tracking?.trackingStartAt
          ? new Date(tracking.trackingStartAt)
          : (syncState?.start_date ? new Date(syncState.start_date) : null);
        if (startAt && msg.sentAt < startAt) {
          continue;
        }

        // Always persist fetched inbound messages so operators can verify ingestion in UI.
        // Relevance controls follow-up/conversation generation only.
        messages.push(msg);

        const relevant = await this.isRelevantEmailWithAi(
          msg,
          employee.email,
          excludePatterns,
          this.gmailService.isNoise(msg.labelIds),
          cycleSettings.email_ai_relevance_enabled,
        );
        if (!relevant) {
          skippedFiltered++;
          continue;
        }

        relevantMessages.push(msg);
        affectedThreads.add(msg.providerThreadId);
      } catch (err) {
        this.logger.warn(`Failed to fetch message ${msgId}: ${(err as Error).message}`);
      }
    }

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

    // Cursor must advance based on all seen messages (not only relevant ones),
    // otherwise filtered messages can be fetched repeatedly and block progress.
    const latestSentAt = messages.reduce<Date | null>((latest, msg) => {
      if (!latest || msg.sentAt > latest) return msg.sentAt;
      return latest;
    }, null);

    const cursor = latestSentAt ?? afterDate;
    await this.updateSyncState(employee.id, cursor, syncState);
    await this.supabase
      .from('employees')
      .update({
        last_synced_at: new Date().toISOString(),
        gmail_status: 'CONNECTED',
      })
      .eq('id', employee.id)
      .eq('company_id', companyId);

    this.logger.log(
      `Ingested ${messages.length} messages (${relevantMessages.length} relevant, ${skippedFiltered} filtered), updated ${conversationsUpdated} conversations for ${employee.name}`,
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

  private async getExcludePatterns(employeeId: string): Promise<string[]> {
    const { data } = await this.supabase
      .from('employees')
      .select('exclude_patterns')
      .eq('id', employeeId)
      .maybeSingle();

    return (data as { exclude_patterns: string[] } | null)?.exclude_patterns ?? [
      'noreply', 'no-reply', 'notifications', 'alerts', 'mailer-daemon',
    ];
  }

  private async isRelevantEmailWithAi(
    message: EmailMessage,
    employeeEmail: string,
    excludePatterns: string[],
    hasNoiseGmailLabel: boolean,
    allowGeminiRelevance: boolean,
  ): Promise<boolean> {
    const heuristic = isRelevantEmail(message, employeeEmail, excludePatterns, hasNoiseGmailLabel);
    if (!allowGeminiRelevance || !this.relevanceModel) return heuristic;

    const prompt = [
      'Classify whether this email should be tracked for follow-up monitoring.',
      'Return ONLY strict JSON: {"relevant":true|false}.',
      'Relevant means a real person-to-person or client-to-business message that may need a reply (support, project, order, meeting, question).',
      'Not relevant: newsletters, promos, automated mail, internal system noise, AND unsolicited product selling or retail-style marketing (catalogs, "buy now", generic sales pitches, decorative promo images with no specific question), even if the subject looks urgent.',
      `employee_email: ${employeeEmail}`,
      `from: ${message.fromEmail}`,
      `to: ${(message.toEmails ?? []).join(', ')}`,
      `subject: ${message.subject ?? ''}`,
      `body_snippet: ${(message.bodyText ?? '').slice(0, 1200)}`,
    ].join('\n');

    try {
      const result = await this.relevanceModel.generateContent(prompt);
      const text = result.response.text().replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(text) as { relevant?: boolean };
      if (typeof parsed.relevant === 'boolean') return parsed.relevant;
      return heuristic;
    } catch (err) {
      this.logger.debug(`AI relevance fallback to heuristic: ${(err as Error).message}`);
      return heuristic;
    }
  }

  private async messageExists(providerMessageId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('email_messages')
      .select('provider_message_id')
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();
    return data !== null;
  }

  private async storeMessages(companyId: string, employeeId: string, messages: EmailMessage[]): Promise<void> {
    const rows = messages.map((msg) => ({
      provider_message_id: msg.providerMessageId,
      provider_thread_id: msg.providerThreadId,
      employee_id: employeeId,
      company_id: companyId,
      direction: msg.direction,
      from_email: msg.fromEmail,
      to_emails: msg.toEmails,
      subject: msg.subject,
      // Basic data minimization: store snippet rather than full body.
      body_text: (msg.bodyText ?? '').slice(0, 2000),
      sent_at: msg.sentAt.toISOString(),
      ingested_at: new Date().toISOString(),
    }));

    const { error } = await this.supabase
      .from('email_messages')
      .upsert(rows, { onConflict: 'provider_message_id', ignoreDuplicates: true });

    if (error) {
      this.logger.error('Failed to store messages', error.message);
      throw error;
    }
  }

  /** Gmail incremental fetch: use the later of last processed cursor and start-tracking window. */
  private effectiveAfterDate(
    lastProcessed: string | null | undefined,
    startDate: string | null | undefined,
  ): Date | null {
    const dates: number[] = [];
    if (lastProcessed) dates.push(new Date(lastProcessed).getTime());
    if (startDate) dates.push(new Date(startDate).getTime());
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates));
  }

  private async getSyncState(employeeId: string) {
    const { data } = await this.supabase
      .from('mail_sync_state')
      .select('*')
      .eq('employee_id', employeeId)
      .maybeSingle();

    return data as {
      employee_id: string;
      start_date: string;
      last_processed_at: string | null;
      last_gmail_history_id: string | null;
    } | null;
  }

  private async updateSyncState(
    employeeId: string,
    lastProcessedAt: Date | null,
    existing: {
      employee_id: string;
      start_date: string;
      last_processed_at: string | null;
      last_gmail_history_id: string | null;
    } | null,
  ): Promise<void> {
    const startDate =
      existing?.start_date ?? new Date('2020-01-01').toISOString();
    const { error } = await this.supabase
      .from('mail_sync_state')
      .upsert(
        {
          employee_id: employeeId,
          start_date: startDate,
          last_processed_at: lastProcessedAt?.toISOString() ?? null,
          last_gmail_history_id: existing?.last_gmail_history_id ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'employee_id' },
      );

    if (error) {
      this.logger.error(`Failed to update sync state for ${employeeId}`, error.message);
    }
  }
}
