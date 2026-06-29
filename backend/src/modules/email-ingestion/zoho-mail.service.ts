import { Injectable, Logger } from '@nestjs/common';
import { OauthTokenService } from '../auth/oauth-token.service';
import { EmailMessage } from '../common/types';
import { retryWithBackoff } from '../common/retry.util';
import type { ZohoOAuthMeta } from '../common/zoho-oauth-credentials';

type ZohoListMessage = {
  messageId?: string | number;
  threadId?: string | number;
  folderId?: string | number;
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

const ZOHO_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatZohoSearchDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = ZOHO_MONTHS[d.getUTCMonth()] ?? 'Jan';
  return `${day}-${month}-${d.getUTCFullYear()}`;
}

@Injectable()
export class ZohoMailService {
  private readonly logger = new Logger(ZohoMailService.name);
  private readonly folderByMessageId = new Map<string, Map<string, string>>();
  private readonly timeByMessageId = new Map<string, Map<string, number>>();
  private readonly rowByMessageId = new Map<string, Map<string, ZohoListMessage>>();

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
      prefer === 'receivedTime'
        ? [row.receivedtime, row.receivedTime, row.received_time]
        : [row.sentdateingmt, row.sentDateInGMT, row.sent_date_in_gmt],
      msg.receivedTime,
      row.receivedtime,
      msg.sentDateInGMT,
      row.sentdateingmt,
    ].flat();
    for (const raw of candidates) {
      const ms = this.parseTimeMs(raw as string | number | undefined);
      if (ms != null) return ms;
    }
    return null;
  }

  /** Timestamp captured when this message id was listed (same ingest/historical request). */
  getListedMessageTime(employeeId: string, messageId: string): number | null {
    const id = zohoId(messageId);
    const cached = this.lookupMessageTime(employeeId, id);
    if (cached != null) return cached;
    const row = this.lookupMessageRow(employeeId, id);
    if (!row) return null;
    return this.messageTimeMs(row, 'receivedTime') ?? this.messageTimeMs(row, 'sentDateInGMT');
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

  private cacheFolderId(employeeId: string, messageId: string, folderId?: string | number): void {
    const fid = zohoId(folderId);
    if (!fid) return;
    const byEmployee =
      this.folderByMessageId.get(employeeId) ?? new Map<string, string>();
    byEmployee.set(messageId, fid);
    this.folderByMessageId.set(employeeId, byEmployee);
  }

  private lookupFolderId(employeeId: string, messageId: string): string | undefined {
    return this.folderByMessageId.get(employeeId)?.get(messageId);
  }

  private cacheMessageRow(employeeId: string, messageId: string, row: ZohoListMessage): void {
    const byEmployee =
      this.rowByMessageId.get(employeeId) ?? new Map<string, ZohoListMessage>();
    byEmployee.set(messageId, row);
    this.rowByMessageId.set(employeeId, byEmployee);
  }

  private lookupMessageRow(employeeId: string, messageId: string): ZohoListMessage | undefined {
    return this.rowByMessageId.get(employeeId)?.get(messageId);
  }

  private cacheMessageTime(employeeId: string, messageId: string, timeMs: number | null): void {
    if (!timeMs || !Number.isFinite(timeMs)) return;
    const byEmployee =
      this.timeByMessageId.get(employeeId) ?? new Map<string, number>();
    byEmployee.set(messageId, timeMs);
    this.timeByMessageId.set(employeeId, byEmployee);
  }

  private lookupMessageTime(employeeId: string, messageId: string): number | undefined {
    return this.timeByMessageId.get(employeeId)?.get(messageId);
  }

  private extractIdsFromRows(
    employeeId: string,
    rows: ZohoListMessage[],
    afterMs: number,
    timeField: 'receivedTime' | 'sentDateInGMT',
  ): string[] {
    const all: string[] = [];
    const filtered: string[] = [];
    for (const m of rows) {
      const id = zohoId(m.messageId);
      if (!id) continue;
      this.cacheFolderId(employeeId, id, m.folderId);
      this.cacheMessageRow(employeeId, id, m);
      const listTime = this.messageTimeMs(m, timeField);
      if (listTime != null) this.cacheMessageTime(employeeId, id, listTime);
      all.push(id);
      const ms = this.messageTimeMs(m, timeField);
      if (ms != null && ms < afterMs) continue;
      filtered.push(id);
    }
    if (filtered.length > 0) return filtered;
    if (all.length > 0) {
      this.logger.warn(
        `Zoho list returned ${all.length} message(s) but none passed after=${new Date(afterMs).toISOString()}; passing ids through for ingest window check`,
      );
      return all;
    }
    return [];
  }

  private async fetchFolderViewRows(
    employeeId: string,
    meta: ZohoOAuthMeta,
    query: string,
  ): Promise<ZohoListMessage[]> {
    const url = `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/view${query}`;
    const res = await retryWithBackoff(
      () => this.zohoFetch(employeeId, meta.mailApiBase, url),
      { operationName: `zoho.list(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
    );
    return this.parseZohoListResponse(res);
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
    const fid = encodeURIComponent(folderId);
    const queryVariants = [
      `?folderId=${fid}&limit=${top}&start=1&includeto=true`,
      `?folderId=${fid}&limit=${top}&start=0&includeto=true`,
      `?folderId=${fid}&limit=${top}&start=1&status=all&includeto=true`,
      `?limit=${top}&start=1&includeto=true`,
    ];
    for (const query of queryVariants) {
      try {
        const rows = await this.fetchFolderViewRows(employeeId, meta, query);
        const ids = this.extractIdsFromRows(employeeId, rows, afterMs, timeField);
        if (ids.length > 0) {
          this.logger.log(
            `Zoho folder list (${query}) returned ${ids.length} id(s) for employee ${employeeId}`,
          );
          return ids;
        }
      } catch (err) {
        this.logger.warn(
          `Zoho folder list failed (${query}) for ${employeeId}: ${(err as Error).message}`,
        );
      }
    }
    return [];
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
    const fromDate = formatZohoSearchDate(afterDate);
    const today = formatZohoSearchDate(new Date());
    const searchKeys = [
      'newMails',
      'in:Inbox',
      'in:inbox',
      `fromDate:${fromDate}::toDate:${today}`,
      `fromDate:${fromDate}`,
    ];
    const startVariants = [1, 0];
    for (const searchKey of searchKeys) {
      for (const start of startVariants) {
        const url =
          `/api/accounts/${encodeURIComponent(meta.accountId)}/messages/search` +
          `?searchKey=${encodeURIComponent(searchKey)}` +
          `&receivedTime=${receivedTime}&limit=${top}&start=${start}&includeto=true`;
        try {
          const res = await retryWithBackoff(
            () => this.zohoFetch(employeeId, meta.mailApiBase, url),
            { operationName: `zoho.search(${employeeId})`, attempts: 2, timeoutMs: 15_000 },
          );
          const rows = await this.parseZohoListResponse(res);
          const ids = this.extractIdsFromRows(employeeId, rows, afterMs, 'receivedTime');
          if (ids.length > 0) {
            this.logger.log(
              `Zoho search fallback (${searchKey}, start=${start}) returned ${ids.length} message(s) for employee ${employeeId}`,
            );
            return ids;
          }
        } catch (err) {
          this.logger.warn(
            `Zoho search fallback (${searchKey}, start=${start}) failed for ${employeeId}: ${(err as Error).message}`,
          );
        }
      }
    }
    return [];
  }

  /** Read-only probe for diagnostics (same paths as live ingest). */
  async probeList(
    employeeId: string,
    afterDate: Date,
    maxResults = 50,
  ): Promise<{ ids: string[]; inboxFolderId?: string; sentFolderId?: string }> {
    const meta = await this.ensureFolderIds(employeeId, await this.getMeta(employeeId), true);
    const page = await this.listMessageIdsPage(employeeId, afterDate, {
      maxResults,
      pageToken: null,
    });
    return {
      ids: page.ids,
      inboxFolderId: meta.inboxFolderId,
      sentFolderId: meta.sentFolderId,
    };
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
    const meta = await this.ensureFolderIds(employeeId, await this.getMeta(employeeId));
    const id = zohoId(messageId);
    const cachedFolder = this.lookupFolderId(employeeId, id);
    const folderCandidates = [cachedFolder, meta.inboxFolderId, meta.sentFolderId].filter(
      (f): f is string => Boolean(f?.trim()),
    );
    if (folderCandidates.length === 0) {
      throw new Error('Zoho folder ids missing');
    }

    let lastErr: Error | null = null;
    for (const folderId of folderCandidates) {
      try {
        const detailsRes = await retryWithBackoff(
          () =>
            this.zohoFetch(
              employeeId,
              meta.mailApiBase,
              `/api/accounts/${encodeURIComponent(meta.accountId)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(id)}/details`,
            ),
          { operationName: `zoho.details(${employeeId})`, attempts: 2, timeoutMs: 12_000 },
        );
        if (!detailsRes.ok) {
          throw new Error(`Zoho details failed: ${detailsRes.status} ${await detailsRes.text()}`);
        }
        const detailsBody = (await detailsRes.json()) as { data?: ZohoFullMessage };
        const details = detailsBody.data;
        if (!details) {
          throw new Error('Zoho details payload missing');
        }

        let content = details.content ?? details.summary ?? '';
        try {
          const contentRes = await retryWithBackoff(
            () =>
              this.zohoFetch(
                employeeId,
                meta.mailApiBase,
                `/api/accounts/${encodeURIComponent(meta.accountId)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(id)}/content`,
              ),
            { operationName: `zoho.content(${employeeId})`, attempts: 2, timeoutMs: 12_000 },
          );
          if (contentRes.ok) {
            const contentBody = (await contentRes.json()) as { data?: { content?: string } };
            if (contentBody.data?.content?.trim()) {
              content = contentBody.data.content;
            }
          }
        } catch {
          /* details.summary is enough for classification */
        }

        return { ...details, messageId: zohoId(details.messageId) || id, content };
      } catch (err) {
        lastErr = err as Error;
      }
    }

    const cached = this.lookupMessageRow(employeeId, id);
    if (cached) {
      this.logger.warn(
        `Zoho details unavailable for ${id}; falling back to list row summary.`,
      );
      return {
        ...cached,
        messageId: id,
        content: cached.summary ?? '',
      };
    }

    throw lastErr ?? new Error(`Zoho get message failed for ${id}`);
  }

  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  private splitAddresses(raw: string | undefined): string[] {
    const trimmed = raw?.trim();
    if (!trimmed || /^not provided$/i.test(trimmed)) return [];
    const decoded = this.decodeHtmlEntities(trimmed);
    const emails = new Set<string>();
    const pattern = /<?\s*([^\s<>,;]+@[^\s<>,;]+)\s*>?/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(decoded)) !== null) {
      const email = match[1]?.trim().toLowerCase();
      if (email?.includes('@')) emails.add(email);
    }
    if (emails.size > 0) return [...emails];
    return decoded
      .split(/[,;]/)
      .map((s) => s.trim().replace(/^.*<([^>]+)>$/, '$1').trim().toLowerCase())
      .filter((s) => s.includes('@'));
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
    // List API receivedTime is reliable for inbox mail; details often return stale/wrong sentDateInGMT.
    const listedMs = this.getListedMessageTime(employeeId, messageId);
    const rawSentMs =
      this.messageTimeMs(msg, 'receivedTime') ??
      this.messageTimeMs(msg, 'sentDateInGMT') ??
      null;
    const sentMs = listedMs ?? rawSentMs ?? Date.now();
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
