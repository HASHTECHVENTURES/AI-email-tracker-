import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { Employee, EmailMessage } from '../common/types';
import { EmployeesService } from '../employees/employees.service';
import { ConversationsService } from '../conversations/conversations.service';
import { SettingsService } from '../settings/settings.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { GmailService } from './gmail.service';

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

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly employeesService: EmployeesService,
    private readonly gmailService: GmailService,
    private readonly conversationsService: ConversationsService,
    private readonly settingsService: SettingsService,
    private readonly dashboardService: DashboardService,
  ) {}

  async runIncrementalCycle(): Promise<IngestionResult[]> {
    const acquired = await this.settingsService.tryAcquireIngestionLock();
    if (!acquired) {
      throw new ConflictException('Ingestion cycle is already running');
    }
    const companyId = process.env.DEFAULT_COMPANY_ID?.trim();
    if (!companyId) {
      throw new ConflictException('DEFAULT_COMPANY_ID is required for ingestion');
    }
    const employees = await this.employeesService.listActive(companyId);
    const results: IngestionResult[] = [];

    try {
      for (const employee of employees) {
        try {
          const result = await this.ingestForEmployee(companyId, employee);
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

      await this.conversationsService.autoArchiveResolved();

      // Auto-generate AI report after ingestion (non-blocking)
      this.dashboardService.generateAiReport(companyId).catch((err) => {
        this.logger.warn(`Auto AI report failed: ${(err as Error).message}`);
      });

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

  private async ingestForEmployee(companyId: string, employee: Employee): Promise<IngestionResult> {
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

        if (!this.isRelevantEmail(msg, employee.email, excludePatterns)) {
          skippedFiltered++;
          continue;
        }

        messages.push(msg);
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

    const latestSentAt = messages.reduce<Date | null>((latest, msg) => {
      if (!latest || msg.sentAt > latest) return msg.sentAt;
      return latest;
    }, afterDate);

    await this.updateSyncState(employee.id, latestSentAt, syncState);

    this.logger.log(
      `Ingested ${messages.length} messages (${skippedFiltered} filtered), updated ${conversationsUpdated} conversations for ${employee.name}`,
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

  private shouldFilter(fromEmail: string, patterns: string[]): boolean {
    const lower = fromEmail.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  private isRelevantEmail(message: EmailMessage, employeeEmail: string, patterns: string[]): boolean {
    const from = message.fromEmail.toLowerCase();
    const subject = message.subject.toLowerCase();
    const body = message.bodyText.toLowerCase();
    const emailDomain = employeeEmail.split('@')[1]?.toLowerCase() ?? '';
    const internal = emailDomain ? from.endsWith(`@${emailDomain}`) : false;
    const keywordHit = /(newsletter|promotion|unsubscribe|weekly digest|deal)/.test(`${subject} ${body}`);
    const automatedDomain = from.includes('mailer-daemon') || from.includes('notifications');
    if (this.shouldFilter(from, patterns) || automatedDomain || internal || keywordHit) return false;
    if (this.gmailService.isNoise(message.labelIds)) return false;
    return true;
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
      body_text: msg.bodyText,
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
