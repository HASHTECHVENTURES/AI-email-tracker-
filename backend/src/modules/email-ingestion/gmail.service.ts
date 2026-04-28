import { Injectable, Logger } from '@nestjs/common';
import { google, gmail_v1 } from 'googleapis';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';
import { getGoogleOAuthCredentials } from '../common/google-oauth-credentials';

/**
 * Gmail label IDs used as a weak hint to Gemini (`isNoise` → prompt), not to exclude from `messages.list`.
 * Category tabs (Promotions/Social/Forums) are no longer filtered in the list query so misfiled client mail can sync.
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
  '-is:muted',
].join(' ');

/** Gmail list query for inbox/sent incremental sync (shared by pagination + single-page fetch). */
export function buildGmailInboxListQuery(afterTimestamp: Date | null): string {
  const parts: string[] = [BASE_QUERY_FILTERS];
  if (afterTimestamp) {
    const epochSeconds = Math.floor(afterTimestamp.getTime() / 1000);
    parts.push(`after:${epochSeconds}`);
  }
  return parts.join(' ');
}

/**
 * Historical backfill: only messages whose internal date falls in [afterDate, beforeDate] (inclusive-ish).
 * Gmail `q` uses Unix seconds for after/before.
 */
export function buildGmailHistoricalWindowQuery(afterDate: Date, beforeDate: Date): string {
  const parts: string[] = [BASE_QUERY_FILTERS];
  const afterSec = Math.floor(afterDate.getTime() / 1000);
  const beforeSec = Math.ceil(beforeDate.getTime() / 1000);
  parts.push(`after:${afterSec}`);
  if (beforeSec > afterSec) {
    parts.push(`before:${beforeSec}`);
  }
  return parts.join(' ');
}

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

  /**
   * One page of message IDs. Use `pageToken` to continue the same list walk (same `q` as first request).
   */
  async listMessageIdsPage(
    employeeId: string,
    query: string,
    opts: { maxResults: number; pageToken?: string | null },
  ): Promise<{ ids: string[]; nextPageToken: string | null }> {
    const gmail = await this.getGmailClient(employeeId);

    try {
      const response = await retryWithBackoff(
        () =>
          gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: opts.maxResults,
            pageToken: opts.pageToken ?? undefined,
          }),
        {
          operationName: `gmail.list(${employeeId})`,
          attempts: 3,
          timeoutMs: 15_000,
          onRetry: (attempt, err, delayMs) => {
            this.logger.warn(
              `Retrying gmail.users.messages.list attempt ${attempt + 1} in ${delayMs}ms: ${(err as Error).message}`,
            );
          },
        },
      );

      const ids = (response.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      const nextPageToken = response.data.nextPageToken ?? null;
      return { ids, nextPageToken };
    } catch (err) {
      this.logger.error(`Failed to list messages for employee ${employeeId}`, (err as Error).message);
      throw err;
    }
  }

  async fetchNewMessageIds(
    employeeId: string,
    afterTimestamp: Date | null,
    maxResults = 20,
  ): Promise<string[]> {
    const query = buildGmailInboxListQuery(afterTimestamp);
    const { ids } = await this.listMessageIdsPage(employeeId, query, { maxResults });
    return ids;
  }

  /** Returns true if Gmail labeled the message as promo/social/forums — passed to Gemini as a weak hint only. */
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

  /**
   * Cheap `messages.get` (metadata + From only) to detect outbound without a full body fetch.
   * Used to recover wrongly AI-skipped Sent mail so reply state can update.
   */
  async peekIsOutboundFrom(employeeId: string, employeeEmail: string, messageId: string): Promise<boolean> {
    const gmail = await this.getGmailClient(employeeId);
    const response = await retryWithBackoff(
      () =>
        gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From'],
        }),
      {
        operationName: `gmail.peekFrom(${employeeId},${messageId})`,
        attempts: 2,
        timeoutMs: 8000,
        onRetry: (a, err, d) =>
          this.logger.warn(`peekIsOutboundFrom retry ${a}: ${(err as Error).message} — ${d}ms`),
      },
    );
    const headers = response.data.payload?.headers ?? [];
    const fromRaw = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
    const fromEmail = this.extractEmail(fromRaw).trim().toLowerCase();
    return fromEmail === employeeEmail.trim().toLowerCase();
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
    const ccRaw = getHeader('Cc');
    const replyToRaw = getHeader('Reply-To');
    const subject = getHeader('Subject');
    const dateStr = getHeader('Date');

    const fromEmail = this.extractEmail(fromRaw);
    const fromName = this.extractDisplayName(fromRaw);
    const replyToEmail = replyToRaw ? this.extractEmail(replyToRaw) : null;
    const toEmails = this.extractEmails(toRaw);
    const ccEmails = this.extractEmails(ccRaw);
    const sentAt = dateStr ? new Date(dateStr) : new Date(Number(msg.internalDate));
    const bodyText = this.extractBestBodyText(msg.payload ?? {});
    const labelIds = (msg.labelIds ?? []) as string[];

    const mailbox = employeeEmail.trim().toLowerCase();
    const fromNorm = fromEmail.trim().toLowerCase();
    const toNorm = toEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    const ccNorm = ccEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    const recipientSet = new Set([...toNorm, ...ccNorm]);

    /**
     * Self-addressed test mail (from me -> to me only) should be treated as inbound so
     * it appears in follow-up views for validation. Regular sent mail remains outbound.
     */
    const selfAddressedOnly = fromNorm === mailbox && recipientSet.size === 1 && recipientSet.has(mailbox);
    const direction: 'INBOUND' | 'OUTBOUND' =
      fromNorm === mailbox && !selfAddressedOnly ? 'OUTBOUND' : 'INBOUND';

    return {
      providerMessageId: msg.id!,
      providerThreadId: msg.threadId!,
      employeeId,
      direction,
      fromEmail,
      fromName,
      replyToEmail,
      toEmails,
      ccEmails,
      subject,
      bodyText,
      sentAt,
      labelIds,
    };
  }

  /**
   * Last up to `maxMessages` messages in the Gmail thread (by internalDate), for Gemini relevance context.
   * Reuses `threads.get` metadata per thread across one ingest batch via `metaByThread`.
   */
  async fetchLastMessagesInThreadForRelevance(
    employeeId: string,
    employeeEmail: string,
    current: EmailMessage,
    metaByThread: Map<string, gmail_v1.Schema$Message[]>,
    maxMessages = 3,
  ): Promise<EmailMessage[]> {
    const threadId = current.providerThreadId;
    if (!threadId) return [current];

    let sorted: gmail_v1.Schema$Message[];
    const cached = metaByThread.get(threadId);
    if (cached) {
      sorted = cached;
    } else {
      const gmail = await this.getGmailClient(employeeId);
      try {
        const res = await retryWithBackoff(
          () =>
            gmail.users.threads.get({
              userId: 'me',
              id: threadId,
              format: 'metadata',
            }),
          {
            operationName: `gmail.threads.get.metadata(${threadId})`,
            attempts: 3,
            timeoutMs: 20_000,
            onRetry: (a, err, d) =>
              this.logger.warn(`threads.get retry ${a}: ${(err as Error).message} — wait ${d}ms`),
          },
        );
        const raw = res.data.messages ?? [];
        sorted = [...raw].sort(
          (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
        );
        metaByThread.set(threadId, sorted);
      } catch (err) {
        this.logger.warn(`threads.get failed for ${threadId}: ${(err as Error).message}`);
        return [current];
      }
    }

    const slice = sorted.slice(-maxMessages);
    const out: EmailMessage[] = [];
    for (const ref of slice) {
      const id = ref.id;
      if (!id) continue;
      if (id === current.providerMessageId) {
        out.push(current);
        continue;
      }
      try {
        out.push(await this.fetchFullMessage(employeeId, employeeEmail, id));
      } catch (e) {
        this.logger.debug(`skip thread sibling ${id}: ${(e as Error).message}`);
      }
    }
    if (out.length === 0) return [current];
    if (!out.some((m) => m.providerMessageId === current.providerMessageId)) {
      out.push(current);
    }
    out.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    return out;
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

  private extractDisplayName(raw: string): string | null {
    if (!raw) return null;
    const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
    if (!m?.[1]) return null;
    const decoded = this.decodeMimeWords(m[1].trim()).replace(/^"+|"+$/g, '').trim();
    if (!decoded) return null;
    // Ignore pseudo-name values that are actually just an email.
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decoded)) return null;
    return decoded;
  }

  /** Decode common RFC2047 MIME encoded-words in headers (e.g. =?UTF-8?B?...?=). */
  private decodeMimeWords(value: string): string {
    return value.replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
      (_full, _charset: string, encoding: string, text: string) => {
        try {
          if (encoding.toUpperCase() === 'B') {
            return Buffer.from(text, 'base64').toString('utf-8');
          }
          const qp = text
            .replace(/_/g, ' ')
            .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            );
          return Buffer.from(qp, 'binary').toString('utf-8');
        } catch {
          return text;
        }
      },
    );
  }

  private extractEmails(raw: string): string[] {
    return raw
      .split(',')
      .map((part) => this.extractEmail(part))
      .filter(Boolean);
  }
}
