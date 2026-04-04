import { Injectable, Logger } from '@nestjs/common';
import { google, gmail_v1 } from 'googleapis';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';
import { getGoogleOAuthCredentials } from '../common/google-oauth-credentials';

/**
 * Gmail label IDs that indicate the message is NOT a direct human conversation.
 * Excluding these at the query level AND on the fetched message.
 */
const NOISE_LABEL_IDS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  // Not CATEGORY_UPDATES — Gmail puts many real client threads (orders, receipts) in Updates; we still filter by content rules.
  'CATEGORY_FORUMS',
  'SPAM',
  'TRASH',
]);

/**
 * Gmail search query modifiers applied to every fetch.
 * We must ingest BOTH inbox + sent messages so follow-up status can turn DONE
 * after an employee reply.
 */
const BASE_QUERY_FILTERS = [
  '{in:inbox in:sent}',
  '-in:spam',
  '-in:trash',
  '-category:promotions',
  '-category:social',
  // Do not exclude category:updates — otherwise many legitimate inbound emails never appear in messages.list.
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

    const { clientId, clientSecret, redirectUri } = getGoogleOAuthCredentials();
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

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

  /**
   * List + fetch up to `maxResults` messages (after optional cursor), for ingestion or tooling.
   */
  async fetchRecentEmails(
    employeeId: string,
    employeeEmail: string,
    afterTimestamp: Date | null,
    maxResults = 20,
  ): Promise<EmailMessage[]> {
    const ids = await this.fetchNewMessageIds(employeeId, afterTimestamp, maxResults);
    const out: EmailMessage[] = [];
    for (const id of ids) {
      try {
        out.push(await this.fetchFullMessage(employeeId, employeeEmail, id));
      } catch (err) {
        this.logger.warn(`fetchRecentEmails: skip message ${id}: ${(err as Error).message}`);
      }
    }
    return out;
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
    const bodyText = this.extractBestBodyText(msg.payload ?? {});
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

  /**
   * Prefer HTML over plain text when both exist (multipart/alternative).
   * Gmail's text/plain often contains only `[image: file.png]` while marketing copy
   * and layout live in text/html.
   */
  private extractBestBodyText(payload: gmail_v1.Schema$MessagePart): string {
    const html = this.findPartBodyByMime(payload, 'text/html');
    if (html) {
      const asText = this.htmlToPlainText(html);
      if (asText.trim()) return asText;
    }
    const plain = this.findPartBodyByMime(payload, 'text/plain');
    if (plain) return plain;

    for (const part of payload.parts ?? []) {
      const nested = this.extractBestBodyText(part);
      if (nested.trim()) return nested;
    }

    if (payload.body?.data && payload.mimeType?.startsWith('text/')) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    return '';
  }

  private findPartBodyByMime(
    payload: gmail_v1.Schema$MessagePart,
    mime: string,
  ): string | null {
    if (payload.mimeType === mime && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    for (const part of payload.parts ?? []) {
      const found = this.findPartBodyByMime(part, mime);
      if (found) return found;
    }
    return null;
  }

  /** Strip HTML to readable plain text; surface alt text for images. */
  private htmlToPlainText(html: string): string {
    let s = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<img[^>]*\salt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) =>
      alt ? ` [Image: ${alt}] ` : ' [Image] ',
    );
    s = s.replace(/<img[^>]*>/gi, ' [Image] ');
    s = s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
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
