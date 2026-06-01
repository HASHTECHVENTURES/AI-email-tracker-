import { Injectable, Logger } from '@nestjs/common';
import { retryWithBackoff } from '../common/retry.util';

export interface MissedFollowUpPayload {
  employeeName: string;
  employeeEmail: string;
  clientEmail: string;
  delayHours: number;
  slaHours: number;
  shortReason: string;
  conversationId: string;
}

/**
 * Sends messages via Telegram Bot API.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  private get token(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim();
  }

  private get chatId(): string | undefined {
    return process.env.TELEGRAM_CHAT_ID?.trim();
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  private async sendRaw(text: string): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    try {
      const res = await retryWithBackoff(
        () =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4090) }),
          }),
        {
          operationName: 'telegram.sendMessage',
          attempts: 3,
          timeoutMs: 8_000,
          shouldRetry: (error) => {
            const message = (error as Error).message ?? '';
            return !message.includes('401') && !message.includes('403');
          },
          onRetry: (attempt, err, delayMs) => {
            this.logger.warn(
              `Retrying Telegram send attempt ${attempt + 1} in ${delayMs}ms: ${(err as Error).message}`,
            );
          },
        },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Telegram API error ${res.status}: ${body}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`Telegram request failed: ${(err as Error).message}`);
      return false;
    }
  }

  async sendMissedFollowUp(p: MissedFollowUpPayload): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const text = [
      '🚨 Follow-up MISSED (SLA breach)',
      '',
      `Client: ${p.clientEmail}`,
      `Employee: ${p.employeeName} (${p.employeeEmail})`,
      `Delay: ${p.delayHours}h · SLA: ${p.slaHours}h`,
      '',
      `Reason: ${p.shortReason || '—'}`,
      '',
      `Conversation: ${p.conversationId}`,
    ].join('\n');

    const sent = await this.sendRaw(text);
    if (sent) this.logger.log(`Telegram alert sent for conversation ${p.conversationId}`);
    return sent;
  }
}
