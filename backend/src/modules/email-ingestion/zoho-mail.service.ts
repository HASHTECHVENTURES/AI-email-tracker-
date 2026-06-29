import { Injectable, Logger } from '@nestjs/common';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';
import type { ZohoOAuthMeta } from '../common/zoho-oauth-credentials';

type ZohoListMessage = {
  messageId?: string | number;
  threadId?: string | number;
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
  folderId?: string | number;
  folderName?: string;
  folderType?: string;
};

function zohoId(raw: unknown): string {
  if (raw == null || raw === '') return '';
  return String(raw).trim();
}

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

  private messageTimeMs(
    msg: ZohoListMessage,
    prefer: 'receivedTime' | 'sentDateInGMT',
  ): number | null {
    const row = msg as Record<string, unknown>;
    const candidates: unknown[] = [
      msg[prefer],
      prefer === 'receivedTime' ? row.receivedtime : row.sentdateingmt,
      msg.sentDateInGMT,
      msg.receivedTime,
    ];
    for (const raw of candidates) {
      const ms = this.parseTimeMs(raw as string | number | undefined);
      if (ms != null) return ms;
    }
    return null;
  }

  private async parseZohoListResponse(res: Response): Promise<ZohoListMessage[]> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Zoho mail API failed (${res.status}): ${text.slice(0, 400)}`);
    }
    let body: { status?: { code?: number; description?: string }; data?: ZohoListMessage[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Zoho mail API returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (body.status?.code != null && body.status.code !== 200) {
      throw new Error(
        `Zoho mail API error ${body.status.code}: ${body.status.description ?? 'unknown'}`,
      );
    }
    return body.data ?? [];
  }

  private extractIdsFromRows(
    rows: ZohoListMessage[],
    afterMs: number,
    timeField: 'receivedTime' | 'sentDateInGMT',
  ): string[] {
    const ids: string[] = [];
    for (const m of rows) {
      const id = zohoId(m.messageId);
      if (!id) continue;
      const ms = this.messageTimeMs(m, timeField);
      if (ms != null && ms < afterMs) continue;
      ids.push(id);
    }
    return ids;
  }

  private async getMeta(employeeId: string): Promise<ZohoOAuthMeta> {
    const meta = await this.oauthTokenService.getZohoMeta(employeeId);
    if (!meta?.accountId || !meta.mailApiBase) {
      throw new Error(`Zoho metadata missing for employee ${employeeId}`);
    }
    return meta;
  }

  private findFolderId(
    folders: ZohoFolder[],
    names: string[],
    folderTypes: string[],
  ): string | undefined {
    const norm = (s: string) => s.trim().toLowerCase();
    const hit = folders.find((f) => {
      const type = norm(f.folderType ?? '');
      if (folderTypes.some((t) => type === norm(t))) return true;
      const name = norm(f.folderName ?? '');
      return names.some((n) => name === norm(n));
    });
    return hit ? zohoId(hit.folderId) : undefined;
  }

  private async ensureFolderIds(
    employeeId: string,
    meta: ZohoOAuthMeta,
    forceRefresh = false,
  ): Promise<ZohoOAuthMeta> {
    if (!forceRefresh && meta.inboxFolderId && meta.sentFolderId) return meta;
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
    const inboxFolderId = forceRefresh
      ? this.findFolderId(folders, ['Inbox', 'INBOX'], ['Inbox', 'INBOX'])
      : meta.inboxFolderId ??
        this.findFolderId(folders, ['Inbox', 'INBOX'], ['Inbox', 'INBOX']);
    const sentFolderId = forceRefresh
      ? this.findFolderId(folders, ['Sent', 'Sent Items', 'SENT'], ['Sent', 'SENT'])
      : meta.sentFolderId ??
        this.findFolderId(folders, ['Sent', 'Sent Items', 'SENT'], ['Sent', 'SENT']);
    const next: ZohoOAuthMeta = {
      ...meta,
      inboxFolderId: inboxFolderId || meta.inboxFolderId,
      sentFolderId: sentFolderId || meta.sentFolderId,
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
      `?folderId=${encodeURIComponent(folderId)}` +
      `&limit=${top}&start=1&status=all&sortBy=date&sortorder=false&includeto=true`;
    const res = await retryWithBackoff(
      () => this.zohoFetch(employeeId, meta.mailApiBase, url),
      { operationName: `zoho.list(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
    );
    const rows = await this.parseZohoListResponse(res);
    return this.extractIdsFromRows(rows, afterMs, timeField);
  }

  /** Fallback when folder view returns nothing — Zoho search uses lowercase receivedtime. */
  private async listInboxViaSearch(
    employeeId: string,
    meta: ZohoOAuthMeta,
    afterDate: Date,
    limit: number,
  ): Promise<string[]> {
    const afterMs = afterDate.getTime();
    const top = Math.min(Math.max(limit, 1), 200);
    const receivedTime = Date.now() + 120_000;
    const searchKeys = ['in:Inbox', 'newMails'];
    for (const searchKey of searchKeys) {
      const url =
        `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/search` +
        `?searchKey=${encodeURIComponent(searchKey)}` +
        `&receivedTime=${receivedTime}&limit=${top}&start=1&includeto=true`;
      try {
        const res = await retryWithBackoff(
          () => this.zohoFetch(employeeId, meta.mailApiBase, url),
          { operationName: `zoho.search(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
        );
        const rows = await this.parseZohoListResponse(res);
        const ids = this.extractIdsFromRows(rows, afterMs, 'receivedTime');
        if (ids.length > 0) {
          this.logger.log(
            `Zoho search fallback (${searchKey}) returned ${ids.length} message(s) for employee ${employeeId}`,
          );
          return ids;
        }
      } catch (err) {
        this.logger.warn(
          `Zoho search fallback (${searchKey}) failed for ${employeeId}: ${(err as Error).message}`,
        );
      }
    }
    return [];
  }

  async listMessageIdsPage(
    employeeId: string,
    afterDate: Date,
    opts: { maxResults: number; pageToken?: string | null },
  ): Promise<{ ids: string[]; nextPageToken: string | null }> {
    if (opts.pageToken) {
      return { ids: [], nextPageToken: null };
    }
    let meta = await this.ensureFolderIds(employeeId, await this.getMeta(employeeId));
    const idSeen = new Set<string>();
    const ids: string[] = [];
    const top = Math.min(opts.maxResults, 200);

    const mergeIds = (batch: string[]) => {
      for (const id of batch) {
        if (!idSeen.has(id)) {
          idSeen.add(id);
          ids.push(id);
        }
      }
    };

    if (meta.inboxFolderId) {
      mergeIds(
        await this.listFolderMessageIds(
          employeeId,
          meta,
          meta.inboxFolderId,
          afterDate,
          top,
          'receivedTime',
        ),
      );
    }
    if (meta.sentFolderId) {
      mergeIds(
        await this.listFolderMessageIds(
          employeeId,
          meta,
          meta.sentFolderId,
          afterDate,
          top,
          'sentDateInGMT',
        ),
      );
    }

    if (ids.length === 0) {
      meta = await this.ensureFolderIds(employeeId, meta, true);
      if (meta.inboxFolderId) {
        mergeIds(
          await this.listFolderMessageIds(
            employeeId,
            meta,
            meta.inboxFolderId,
            afterDate,
            top,
            'receivedTime',
          ),
        );
      }
      if (ids.length === 0) {
        mergeIds(await this.listInboxViaSearch(employeeId, meta, afterDate, top));
      }
    }

    return { ids, nextPageToken: null };
  }

  async listRecentInboxHead(
    employeeId: string,
    afterDate: Date,
    maxResults: number,
  ): Promise<string[]> {
    const page = await this.listMessageIdsPage(employeeId, afterDate, {
      maxResults,
      pageToken: null,
    });
    return page.ids;
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
    const id = zohoId(messageId);
    const res = await retryWithBackoff(
      () =>
        this.zohoFetch(
          employeeId,
          meta.mailApiBase,
          `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/${encodeURIComponent(id)}`,
        ),
      { operationName: `zoho.get(${employeeId})`, attempts: 3, timeoutMs: 12_000 },
    );
    if (!res.ok) {
      throw new Error(`Zoho get message failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: ZohoFullMessage };
    const msg = body.data;
    if (!zohoId(msg?.messageId)) {
      throw new Error('Zoho message payload missing');
    }
    return msg!;
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
      this.messageTimeMs(msg, 'sentDateInGMT') ??
      this.messageTimeMs(msg, 'receivedTime') ??
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

    const providerMessageId = zohoId(msg.messageId);
    const providerThreadId = zohoId(msg.threadId) || providerMessageId;

    return {
      providerMessageId,
      providerThreadId,
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
