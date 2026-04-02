import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../common/supabase.provider';
import { FollowUpStatus } from '../common/types';
import { TelegramService } from './telegram.service';
import { EmailService } from '../email/email.service';

/** Stored in `alerts.status_transition`; must match dedupe lookup */
export const STATUS_TRANSITION_PENDING_TO_MISSED = 'PENDING_TO_MISSED';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly telegramService: TelegramService,
    private readonly emailService: EmailService,
  ) {}

  shouldTriggerTransitionAlert(
    oldStatus: FollowUpStatus | null,
    newStatus: FollowUpStatus,
  ): boolean {
    return oldStatus === 'PENDING' && newStatus === 'MISSED';
  }

  async hasAlreadySent(conversationId: string, transition: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('alerts')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('status_transition', transition)
      .maybeSingle();

    return data !== null;
  }

  async createAlert(
    conversationId: string,
    employeeId: string,
    statusTransition: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.supabase.from('alerts').insert({
      conversation_id: conversationId,
      employee_id: employeeId,
      status_transition: statusTransition,
      payload_json: payload ?? null,
      sent_at: new Date().toISOString(),
      delivery_status: 'SENT',
    });

    if (error) {
      this.logger.error(`Failed to create alert for ${conversationId}`, error.message);
    }
  }

  async list(employeeId?: string) {
    let query = this.supabase
      .from('alerts')
      .select('*')
      .order('sent_at', { ascending: false });

    if (employeeId) {
      query = query.eq('employee_id', employeeId);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error('Failed to list alerts', error.message);
      return [];
    }

    return data ?? [];
  }

  async count(): Promise<number> {
    const { count } = await this.supabase
      .from('alerts')
      .select('*', { count: 'exact', head: true });

    return count ?? 0;
  }

  /**
   * On PENDING → MISSED: send Telegram (if configured), then record alert in DB for dedupe.
   */
  async notifyPendingToMissedIfNeeded(params: {
    companyId: string;
    conversationId: string;
    employeeId: string;
    oldStatus: FollowUpStatus | null;
    newStatus: FollowUpStatus;
    employeeName: string;
    employeeEmail: string;
    clientEmail: string | null;
    delayHours: number;
    slaHours: number;
    shortReason: string;
  }): Promise<void> {
    const {
      companyId,
      conversationId,
      employeeId,
      oldStatus,
      newStatus,
      employeeName,
      employeeEmail,
      clientEmail,
      delayHours,
      slaHours,
      shortReason,
    } = params;

    if (!this.shouldTriggerTransitionAlert(oldStatus, newStatus)) {
      return;
    }

    if (await this.hasAlreadySent(conversationId, STATUS_TRANSITION_PENDING_TO_MISSED)) {
      return;
    }

    await this.createAlert(conversationId, employeeId, STATUS_TRANSITION_PENDING_TO_MISSED, {
      client_email: clientEmail,
      delay_hours: delayHours,
      sla_hours: slaHours,
    });

    void this.emailService.maybeSendMissedAlert(companyId, {
      employee: employeeName,
      hours: delayHours,
      status: 'MISSED',
      client_email: clientEmail ?? '',
    }, conversationId);

    if (!this.telegramService.isConfigured()) {
      this.logger.warn(
        `PENDING→MISSED for ${conversationId} — Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)`,
      );
      return;
    }

    const sent = await this.telegramService.sendMissedFollowUp({
      employeeName,
      employeeEmail,
      clientEmail: clientEmail ?? '—',
      delayHours,
      slaHours,
      shortReason,
      conversationId,
    });

    if (!sent) {
      this.logger.warn(`Telegram send failed for ${conversationId}`);
    }
  }
}
