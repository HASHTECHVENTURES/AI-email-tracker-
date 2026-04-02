import { Injectable, Logger } from '@nestjs/common';
import { google, gmail_v1 } from 'googleapis';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';

/**
 * Gmail label IDs that indicate the message is NOT a direct human conversation.
 * Excluding these at the query level AND on the fetched message.
 */
const NOISE_LABEL_IDS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'SPAM',
  'TRASH',
]);

/**
 * Gmail search query modifiers applied to every fetch.
 * - in:inbox         → only real inbox (no spam/trash/sent)
 * - -category:…      → strip Gmail auto-categorised tabs
 * - -is:muted        → skip muted threads
 */
const BASE_QUERY_FILTERS = [
  'in:inbox',
  '-category:promotions',
  '-category:social',
  '-category:updates',
  '-category:forums',
  '-is:muted',
].join(' ');

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(private readonly oauthTokenService: OauthTokenService) {}

  private async getGmailClient(employeeId: string): Promise<gmail_v1.Gmail> {
    const accessToken = await this.oauthTokenService.getValidAccessToken(employeeId);
    const refreshToken = await this.oauthTokenService.getRefreshToken(employeeId);

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );

    oauth2.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    return google.gmail({ version: 'v1', auth: oauth2 });
  }

  async fetchNewMessageIds(
    employeeId: string,
    afterTimestamp: Date | null,
    maxResults = 20,
  ): Promise<string[]> {
    const gmail = await this.getGmailClient(employeeId);

    const parts: string[] = [BASE_QUERY_FILTERS];
    if (afterTimestamp) {
      const epochSeconds = Math.floor(afterTimestamp.getTime() / 1000);
      parts.push(`after:${epochSeconds}`);
    }
    const query = parts.join(' ');

    try {
      const response = await retryWithBackoff(
        () => gmail.users.messages.list({ userId: 'me', q: query, maxResults }),
        {
          operationName: `gmail.list(${employeeId})`,
          attempts: 3,
          timeoutMs: 10_000,
          onRetry: (attempt, err, delayMs) => {
            this.logger.warn(
              `Retrying gmail.users.messages.list attempt ${attempt + 1} in ${delayMs}ms: ${(err as Error).message}`,
            );
          },
        },
      );

      return (response.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    } catch (err) {
      this.logger.error(`Failed to list messages for employee ${employeeId}`, (err as Error).message);
      throw err;
    }
  }

  /** Returns true if the message has a noise label — second safety net after query filters. */
  isNoise(labelIds: string[] | undefined): boolean {
    if (!labelIds) return false;
    return labelIds.some((l) => NOISE_LABEL_IDS.has(l));
  }

  async fetchFullMessage(
    employeeId: string,
    employeeEmail: string,
    messageId: string,
  ): Promise<EmailMessage> {
    const gmail = await this.getGmailClient(employeeId);

    const response = await retryWithBackoff(
      () =>
        gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        }),
      {
        operationName: `gmail.get(${employeeId},${messageId})`,
        attempts: 3,
        timeoutMs: 10_000,
        onRetry: (attempt, err, delayMs) => {
          this.logger.warn(
            `Retrying gmail.users.messages.get attempt ${attempt + 1} in ${delayMs}ms: ${(err as Error).message}`,
          );
        },
      },
    );

    const msg = response.data;
    const headers = msg.payload?.headers ?? [];

    const getHeader = (name: string): string => {
      const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
      return header?.value ?? '';
    };

    const fromRaw = getHeader('From');
    const toRaw = getHeader('To');
    const subject = getHeader('Subject');
    const dateStr = getHeader('Date');

    const fromEmail = this.extractEmail(fromRaw);
    const toEmails = this.extractEmails(toRaw);
    const sentAt = dateStr ? new Date(dateStr) : new Date(Number(msg.internalDate));
    const bodyText = this.extractPlainText(msg.payload ?? {});
    const labelIds = (msg.labelIds ?? []) as string[];

    const direction: 'INBOUND' | 'OUTBOUND' =
      fromEmail.toLowerCase() === employeeEmail.toLowerCase() ? 'OUTBOUND' : 'INBOUND';

    return {
      providerMessageId: msg.id!,
      providerThreadId: msg.threadId!,
      employeeId,
      direction,
      fromEmail,
      toEmails,
      subject,
      bodyText,
      sentAt,
      labelIds,
    };
  }

  private extractPlainText(payload: gmail_v1.Schema$MessagePart): string {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    for (const part of payload.parts ?? []) {
      const text = this.extractPlainText(part);
      if (text) return text;
    }

    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    return '';
  }

  private extractEmail(raw: string): string {
    const match = raw.match(/<([^>]+)>/);
    return match ? match[1] : raw.trim();
  }

  private extractEmails(raw: string): string[] {
    return raw
      .split(',')
      .map((part) => this.extractEmail(part))
      .filter(Boolean);
  }
}
