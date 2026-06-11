import { Injectable, Logger } from '@nestjs/common';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

type GraphMessageListItem = {
  id: string;
  receivedDateTime?: string;
  sentDateTime?: string;
};

type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  sender?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  replyTo?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  categories?: string[];
};

@Injectable()
export class MicrosoftGraphService {
  private readonly logger = new Logger(MicrosoftGraphService.name);

  constructor(private readonly oauthTokenService: OauthTokenService) {}

  private async graphFetch(
    employeeId: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await this.oauthTokenService.getValidAccessToken(employeeId);
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  }

  private isoFilterAfter(d: Date): string {
    return `'${d.toISOString()}'`;
  }

  async listMessageIdsPage(
    employeeId: string,
    afterDate: Date,
    opts: { maxResults: number; pageToken?: string | null },
  ): Promise<{ ids: string[]; nextPageToken: string | null }> {
    if (opts.pageToken) {
      const res = await retryWithBackoff(
        () => this.graphFetch(employeeId, opts.pageToken!),
        { operationName: `graph.list.next(${employeeId})`, attempts: 3, timeoutMs: 15_000 },
      );
      if (!res.ok) {
        throw new Error(`Graph list next failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { value?: GraphMessageListItem[]; '@odata.nextLink'?: string };
      const ids = (data.value ?? []).map((m) => m.id).filter(Boolean);
      return { ids, nextPageToken: data['@odata.nextLink'] ?? null };
    }

    const afterIso = this.isoFilterAfter(afterDate);
    const top = Math.min(opts.maxResults, 200);
    const inboxUrl =
      `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${afterIso}` +
      `&$orderby=receivedDateTime desc&$top=${top}&$select=id,receivedDateTime`;
    const sentUrl =
      `/me/mailFolders/sentItems/messages?$filter=sentDateTime ge ${afterIso}` +
      `&$orderby=sentDateTime desc&$top=${top}&$select=id,sentDateTime`;

    const idSeen = new Set<string>();
    const ids: string[] = [];
    let nextPageToken: string | null = null;

    for (const url of [inboxUrl, sentUrl]) {
      try {
        const res = await retryWithBackoff(
          () => this.graphFetch(employeeId, url),
          { operationName: `graph.list(${employeeId})`, attempts: 3, timeoutMs: 15_000 },
        );
        if (!res.ok) {
          this.logger.warn(`Graph list failed ${url}: ${res.status} ${await res.text()}`);
          continue;
        }
        const data = (await res.json()) as { value?: GraphMessageListItem[]; '@odata.nextLink'?: string };
        for (const m of data.value ?? []) {
          if (m.id && !idSeen.has(m.id)) {
            idSeen.add(m.id);
            ids.push(m.id);
          }
        }
        if (!nextPageToken && data['@odata.nextLink']) {
          nextPageToken = data['@odata.nextLink'];
        }
      } catch (err) {
        this.logger.warn(`Graph list error: ${(err as Error).message}`);
      }
    }

    return { ids, nextPageToken };
  }

  async listRecentInboxHead(
    employeeId: string,
    afterDate: Date,
    maxResults: number,
  ): Promise<string[]> {
    const afterIso = this.isoFilterAfter(afterDate);
    const url =
      `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${afterIso}` +
      `&$orderby=receivedDateTime desc&$top=${maxResults}&$select=id`;
    const res = await this.graphFetch(employeeId, url);
    if (!res.ok) return [];
    const data = (await res.json()) as { value?: GraphMessageListItem[] };
    return (data.value ?? []).map((m) => m.id).filter(Boolean);
  }

  isNoise(categories: string[] | undefined): boolean {
    if (!categories?.length) return false;
    return categories.some((c) => /promo|newsletter|social|marketing|bulk/i.test(c));
  }

  async peekIsOutboundFrom(
    employeeId: string,
    employeeEmail: string,
    messageId: string,
  ): Promise<boolean> {
    const res = await this.graphFetch(
      employeeId,
      `/me/messages/${encodeURIComponent(messageId)}?$select=from,sender`,
    );
    if (!res.ok) return false;
    const msg = (await res.json()) as GraphMessage;
    const from =
      msg.from?.emailAddress?.address ?? msg.sender?.emailAddress?.address ?? '';
    return from.trim().toLowerCase() === employeeEmail.trim().toLowerCase();
  }

  async fetchFullMessage(
    employeeId: string,
    employeeEmail: string,
    messageId: string,
  ): Promise<EmailMessage> {
    const res = await retryWithBackoff(
      () =>
        this.graphFetch(
          employeeId,
          `/me/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,subject,body,bodyPreview,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,categories`,
        ),
      { operationName: `graph.get(${employeeId})`, attempts: 3, timeoutMs: 12_000 },
    );
    if (!res.ok) {
      throw new Error(`Graph get message failed: ${res.status} ${await res.text()}`);
    }
    const msg = (await res.json()) as GraphMessage;

    const fromEmail =
      msg.from?.emailAddress?.address ?? msg.sender?.emailAddress?.address ?? '';
    const fromName = msg.from?.emailAddress?.name ?? msg.sender?.emailAddress?.name ?? null;
    const toEmails = (msg.toRecipients ?? [])
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean);
    const ccEmails = (msg.ccRecipients ?? [])
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean);
    const replyToEmail = msg.replyTo?.[0]?.emailAddress?.address ?? null;
    const subject = msg.subject ?? '';
    const sentAt = new Date(msg.receivedDateTime ?? msg.sentDateTime ?? Date.now());
    const bodyText = this.extractBodyText(msg);

    const mailbox = employeeEmail.trim().toLowerCase();
    const fromNorm = fromEmail.trim().toLowerCase();
    const recipientSet = new Set([
      ...toEmails.map((e) => e.trim().toLowerCase()),
      ...ccEmails.map((e) => e.trim().toLowerCase()),
    ]);
    const selfAddressedOnly =
      fromNorm === mailbox && recipientSet.size === 1 && recipientSet.has(mailbox);
    const direction: 'INBOUND' | 'OUTBOUND' =
      fromNorm === mailbox && !selfAddressedOnly ? 'OUTBOUND' : 'INBOUND';

    return {
      providerMessageId: msg.id,
      providerThreadId: msg.conversationId ?? msg.id,
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
      labelIds: msg.categories,
    };
  }

  async fetchLastMessagesInThreadForRelevance(
    employeeId: string,
    employeeEmail: string,
    current: EmailMessage,
    _metaByThread: Map<string, unknown>,
    maxMessages = 1,
  ): Promise<EmailMessage[]> {
    const convId = current.providerThreadId;
    if (!convId) return [current];
    const filter = encodeURIComponent(`conversationId eq '${convId.replace(/'/g, "''")}'`);
    const url =
      `/me/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=${Math.max(maxMessages, 3)}&$select=id`;
    const res = await this.graphFetch(employeeId, url);
    if (!res.ok) return [current];
    const data = (await res.json()) as { value?: GraphMessageListItem[] };
    const ids = (data.value ?? []).map((m) => m.id).filter(Boolean);
    const out: EmailMessage[] = [];
    for (const id of ids.slice(-maxMessages)) {
      if (id === current.providerMessageId) {
        out.push(current);
        continue;
      }
      try {
        out.push(await this.fetchFullMessage(employeeId, employeeEmail, id));
      } catch {
        /* skip sibling */
      }
    }
    if (out.length === 0) return [current];
    out.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    return out;
  }

  private extractBodyText(msg: GraphMessage): string {
    const content = msg.body?.content ?? msg.bodyPreview ?? '';
    if (msg.body?.contentType?.toLowerCase() === 'html') {
      return this.htmlToPlainText(content);
    }
    return content;
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
