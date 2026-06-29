import { Injectable, Logger } from '@nestjs/common';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';
import type { ZohoOAuthMeta } from '../common/zoho-oauth-credentials';

type ZohoListMessage = {
  messageId?: string;
  threadId?: string;
  subject?: string;
  summary?: string;
  fromAddress?: string;
  sender?: string;
  toAddress?: string;
  receivedTime?: string | number;
  sentDateInGMT?: string | number;
  status?: string;
};

type ZohoFullMessage = ZohoListMessage & {
  content?: string;
  ccAddress?: string;
  replyTo?: string;
};

type ZohoFolder = {
  folderId?: string;
  folderName?: string;
};

@Injectable()
export class ZohoMailService {
  private readonly logger = new Logger(ZohoMailService.name);

  constructor(private readonly oauthTokenService: OauthTokenService) {}

  private async zohoFetch(
    employeeId: string,
    mailApiBase: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await this.oauthTokenService.getValidAccessToken(employeeId);
    const url = path.startsWith('http') ? path : `${mailApiBase}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  }

  private parseTimeMs(raw: string | number | undefined): number | null {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n < 1e12 ? n * 1000 : n;
    }
    const d = new Date(raw).getTime();
    return Number.isFinite(d) ? d : null;
  }

  private async getMeta(employeeId: string): Promise<ZohoOAuthMeta> {
    const meta = await this.oauthTokenService.getZohoMeta(employeeId);
    if (!meta?.accountId || !meta.mailApiBase) {
      throw new Error(`Zoho metadata missing for employee ${employeeId}`);
    }
    return meta;
  }

  private async ensureFolderIds(
    employeeId: string,
    meta: ZohoOAuthMeta,
  ): Promise<ZohoOAuthMeta> {
    if (meta.inboxFolderId && meta.sentFolderId) return meta;
    const res = await retryWithBackoff(
      () =>
        this.zohoFetch(
          employeeId,
          meta.mailApiBase,
          `/api/accounts/${encodeURIComponent(meta.accountId)}/folders`,
        ),
      { operationName: `zoho.folders(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
    );
    if (!res.ok) {
      throw new Error(`Zoho folders failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: ZohoFolder[] };
    const folders = body.data ?? [];
    const findFolder = (names: string[]) =>
      folders.find((f) =>
        names.some((n) => (f.folderName ?? '').trim().toLowerCase() === n.toLowerCase()),
      )?.folderId;
    const inboxFolderId = meta.inboxFolderId ?? findFolder(['Inbox', 'INBOX']);
    const sentFolderId = meta.sentFolderId ?? findFolder(['Sent', 'Sent Items', 'SENT']);
    const next: ZohoOAuthMeta = {
      ...meta,
      inboxFolderId: inboxFolderId ?? meta.inboxFolderId,
      sentFolderId: sentFolderId ?? meta.sentFolderId,
    };
    await this.oauthTokenService.updateZohoMeta(employeeId, next);
    return next;
  }

  private async listFolderMessageIds(
    employeeId: string,
    meta: ZohoOAuthMeta,
    folderId: string,
    afterDate: Date,
    limit: number,
    timeField: 'receivedTime' | 'sentDateInGMT',
  ): Promise<string[]> {
    const afterMs = afterDate.getTime();
    const top = Math.min(Math.max(limit, 1), 200);
    const url =
      `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/view` +
      `?folderId=${encodeURIComponent(folderId)}&limit=${top}&start=1&includeto=true`;
    const res = await retryWithBackoff(
      () => this.zohoFetch(employeeId, meta.mailApiBase, url),
      { operationName: `zoho.list(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
    );
    if (!res.ok) {
      this.logger.warn(`Zoho list failed (${res.status}): ${(await res.text()).slice(0, 240)}`);
      return [];
    }
    const body = (await res.json()) as { data?: ZohoListMessage[] };
    const ids: string[] = [];
    for (const m of body.data ?? []) {
      const ms = this.parseTimeMs(m[timeField]);
      const id = m.messageId?.trim();
      if (!id) continue;
      if (ms != null && ms < afterMs) continue;
      ids.push(id);
    }
    return ids;
  }

  async listMessageIdsPage(
    employeeId: string,
    afterDate: Date,
    opts: { maxResults: number; pageToken?: string | null },
  ): Promise<{ ids: string[]; nextPageToken: string | null }> {
    if (opts.pageToken) {
      return { ids: [], nextPageToken: null };
    }
    const meta = await this.ensureFolderIds(employeeId, await this.getMeta(employeeId));
    const idSeen = new Set<string>();
    const ids: string[] = [];
    const top = Math.min(opts.maxResults, 200);

    if (meta.inboxFolderId) {
      for (const id of await this.listFolderMessageIds(
        employeeId,
        meta,
        meta.inboxFolderId,
        afterDate,
        top,
        'receivedTime',
      )) {
        if (!idSeen.has(id)) {
          idSeen.add(id);
          ids.push(id);
        }
      }
    }
    if (meta.sentFolderId) {
      for (const id of await this.listFolderMessageIds(
        employeeId,
        meta,
        meta.sentFolderId,
        afterDate,
        top,
        'sentDateInGMT',
      )) {
        if (!idSeen.has(id)) {
          idSeen.add(id);
          ids.push(id);
        }
      }
    }
    return { ids, nextPageToken: null };
  }

  async listRecentInboxHead(
    employeeId: string,
    afterDate: Date,
    maxResults: number,
  ): Promise<string[]> {
    const meta = await this.ensureFolderIds(employeeId, await this.getMeta(employeeId));
    if (!meta.inboxFolderId) return [];
    return this.listFolderMessageIds(
      employeeId,
      meta,
      meta.inboxFolderId,
      afterDate,
      maxResults,
      'receivedTime',
    );
  }

  isNoise(_labelIds: string[] | undefined): boolean {
    return false;
  }

  async peekIsOutboundFrom(
    employeeId: string,
    employeeEmail: string,
    messageId: string,
  ): Promise<boolean> {
    try {
      const msg = await this.fetchZohoMessageRaw(employeeId, messageId);
      const from = (msg.fromAddress ?? msg.sender ?? '').trim().toLowerCase();
      return from === employeeEmail.trim().toLowerCase();
    } catch {
      return false;
    }
  }

  private async fetchZohoMessageRaw(
    employeeId: string,
    messageId: string,
  ): Promise<ZohoFullMessage> {
    const meta = await this.getMeta(employeeId);
    const res = await retryWithBackoff(
      () =>
        this.zohoFetch(
          employeeId,
          meta.mailApiBase,
          `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/${encodeURIComponent(messageId)}`,
        ),
      { operationName: `zoho.get(${employeeId})`, attempts: 3, timeoutMs: 12_000 },
    );
    if (!res.ok) {
      throw new Error(`Zoho get message failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: ZohoFullMessage };
    const msg = body.data;
    if (!msg?.messageId) {
      throw new Error('Zoho message payload missing');
    }
    return msg;
  }

  private splitAddresses(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
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

  async fetchFullMessage(
    employeeId: string,
    employeeEmail: string,
    messageId: string,
  ): Promise<EmailMessage> {
    const msg = await this.fetchZohoMessageRaw(employeeId, messageId);
    const fromEmail = (msg.fromAddress ?? msg.sender ?? '').trim();
    const toEmails = this.splitAddresses(msg.toAddress);
    const ccEmails = this.splitAddresses(msg.ccAddress);
    const replyToEmail = msg.replyTo?.trim() || null;
    const subject = msg.subject ?? '';
    const sentMs =
      this.parseTimeMs(msg.sentDateInGMT) ??
      this.parseTimeMs(msg.receivedTime) ??
      Date.now();
    const sentAt = new Date(sentMs);
    const rawBody = msg.content ?? msg.summary ?? '';
    const bodyText = /<[a-z][\s\S]*>/i.test(rawBody) ? this.htmlToPlainText(rawBody) : rawBody;

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
      providerMessageId: msg.messageId!,
      providerThreadId: msg.threadId ?? msg.messageId!,
      employeeId,
      direction,
      fromEmail,
      fromName: null,
      replyToEmail,
      toEmails,
      ccEmails,
      subject,
      bodyText,
      sentAt,
    };
  }

  async fetchLastMessagesInThreadForRelevance(
    employeeId: string,
    employeeEmail: string,
    current: EmailMessage,
    _metaByThread: Map<string, unknown>,
    maxMessages = 1,
  ): Promise<EmailMessage[]> {
    return [current];
  }
}
