'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import {
  apiFetch,
  apiPostSse,
  formatNetworkFetchFailureMessage,
  oauthErrorMessage,
  readApiErrorMessage,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/AppShell';
import { PageSkeleton } from '@/components/PageSkeleton';
import { TrackedMailboxCard } from '@/components/my-email/TrackedMailboxCard';
import { conversationReadPath } from '@/lib/conversation-read';

type Mailbox = {
  id: string;
  name: string;
  email: string;
  /** `SELF` = CEO-added; `TEAM` / missing = org / manager mail — used to split UI sections */
  mailbox_type?: 'SELF' | 'TEAM' | null;
  /** Set by API for CEO: this row is a department manager’s inbox (not a generic team mailbox). */
  is_manager_mailbox?: boolean;
  gmail_connected?: boolean;
  gmail_status?: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
  ai_enabled?: boolean;
};

/** Same fallback as self-tracking when `sla_hours_default` is null (see backend self-tracking.service). */
const DEFAULT_MAILBOX_SLA_HOURS = 24;

function effectiveMailboxSlaHours(mb: Mailbox): number {
  const v = mb.sla_hours_default;
  if (v != null && v > 0) return v;
  return DEFAULT_MAILBOX_SLA_HOURS;
}

type ConversationRow = {
  conversation_id: string;
  employee_id: string;
  employee_name: string;
  provider_thread_id: string;
  client_name: string | null;
  client_email: string | null;
  follow_up_status: string;
  priority: string;
  delay_hours: number;
  sla_hours: number;
  summary: string;
  short_reason: string;
  reason: string;
  last_client_msg_at: string | null;
  last_employee_reply_at: string | null;
  lifecycle_status: string;
  open_gmail_link: string;
  updated_at: string;
  follow_up_required?: boolean;
  /** Latest inbound had you only on Cc, not To. */
  user_cc_only?: boolean;
};

const MAIL_PAGE_SIZE = 50;

type MailTab = 'action' | 'waiting' | 'cc' | 'closed' | 'noise' | 'all';

/** Mirrors GET /settings (includes company_admin_ai_enabled). Used before Start to gate ingest without Inbox AI. */
type IngestAiSettings = {
  email_ai_relevance_enabled: boolean;
  gemini_api_key_configured: boolean;
  email_ingest_without_ai_confirmed: boolean;
  company_admin_ai_enabled: boolean;
};

/** Coerce /settings JSON — avoids false modal when booleans arrive as strings or fields are omitted. */
function normalizeIngestAiSettings(raw: Record<string, unknown>): IngestAiSettings {
  const truthy = (v: unknown) => v === true || v === 'true' || v === 'TRUE';
  const keyRaw = raw.gemini_api_key_configured;
  const gemini_api_key_configured =
    keyRaw === true ||
    keyRaw === 1 ||
    truthy(keyRaw) ||
    (typeof keyRaw === 'string' && ['true', '1'].includes(keyRaw.trim().toLowerCase()));

  const companyRaw = raw.company_admin_ai_enabled;
  const company_admin_ai_enabled =
    companyRaw === undefined || companyRaw === null
      ? true
      : companyRaw !== false && companyRaw !== 'false';

  return {
    email_ai_relevance_enabled: raw.email_ai_relevance_enabled !== false && raw.email_ai_relevance_enabled !== 'false',
    gemini_api_key_configured,
    email_ingest_without_ai_confirmed: truthy(raw.email_ingest_without_ai_confirmed),
    company_admin_ai_enabled,
  };
}

/** Human-readable blockers when Inbox AI cannot run — empty means Gemini can classify. */
function getInboxAiBlockers(s: IngestAiSettings, mb: Mailbox): string[] {
  const blockers: string[] = [];
  if (s.company_admin_ai_enabled === false) {
    blockers.push(
      'Platform Admin → Companies → your company → AI enabled must be ON (or ask your admin).',
    );
  }
  if (s.email_ai_relevance_enabled === false) {
    blockers.push(
      'Settings → turn the company AI master ON (includes Inbox AI / email relevance), or re-enable Inbox AI in CEO settings.',
    );
  }
  if (!s.gemini_api_key_configured) {
    blockers.push(
      'The API your browser calls does not see a Gemini key yet. Add GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) on the **same Railway service that runs this backend**, then click **Redeploy** (variables apply to new deploys). Check `https://YOUR-BACKEND-HOST/health` — `gemini_configured` must be `true`.',
    );
    blockers.push(
      'If `/health` already shows `gemini_configured: true` but you still see this, the **frontend is pointed at a different server**: set `NEXT_PUBLIC_API_URL` on Vercel (or your host) to that Railway API URL and redeploy the frontend.',
    );
  }
  if (mb.ai_enabled === false) {
    blockers.push('Employees → this mailbox → turn Mailbox AI ON for this inbox.');
  }
  return blockers;
}

function inboxGeminiWillClassify(s: IngestAiSettings, mb: Mailbox): boolean {
  return getInboxAiBlockers(s, mb).length === 0;
}

/** CEO owes a reply: client last spoke or SLA missed. */
function needsMyReply(c: ConversationRow): boolean {
  if (c.follow_up_status === 'DONE') return false;
  if (c.follow_up_status === 'MISSED') return true;
  const lc = c.last_client_msg_at ? new Date(c.last_client_msg_at).getTime() : 0;
  const lr = c.last_employee_reply_at ? new Date(c.last_employee_reply_at).getTime() : 0;
  if (lc === 0 && lr === 0) return c.follow_up_status === 'PENDING';
  return lc > lr;
}

/** Last inbound client message older than N calendar days → treated as “stale” for Need your reply. */
const STALE_NEED_REPLY_DAYS = 30;
/** Always on: Need your reply lists only threads with a client message in the last STALE_NEED_REPLY_DAYS days; older overdue items remain in All threads. */
const HIDE_STALE_NEED_REPLY = true;

function isStaleNeedReplyByClientMessage(c: ConversationRow, staleDays: number): boolean {
  if (!needsMyReply(c)) return false;
  const iso = c.last_client_msg_at;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > staleDays * 86_400_000;
}

/** Ball in their court: we replied at or after their last message. */
function isWaitingOnThem(c: ConversationRow): boolean {
  if (c.follow_up_status === 'DONE' || c.follow_up_status === 'MISSED') return false;
  const lc = c.last_client_msg_at ? new Date(c.last_client_msg_at).getTime() : 0;
  const lr = c.last_employee_reply_at ? new Date(c.last_employee_reply_at).getTime() : 0;
  if (lr === 0) return false;
  return lr >= lc;
}

function slaChipLabel(c: ConversationRow): { text: string; className: string } {
  if (c.follow_up_status === 'MISSED') {
    return {
      text: `Missed · +${Number(c.delay_hours).toFixed(0)}h`,
      className: 'bg-red-100 text-red-800',
    };
  }
  if (c.follow_up_status === 'DONE') {
    return { text: 'Done', className: 'bg-emerald-100 text-emerald-800' };
  }
  const left = c.sla_hours - c.delay_hours;
  if (left <= 0) {
    return { text: 'Due now', className: 'bg-amber-100 text-amber-900' };
  }
  if (left <= 4) {
    return { text: `Due in ${left.toFixed(0)}h`, className: 'bg-amber-100 text-amber-800' };
  }
  return { text: `${left.toFixed(0)}h left`, className: 'bg-slate-100 text-slate-700' };
}

type SyncedMailItem = {
  provider_message_id: string;
  provider_thread_id: string;
  subject: string;
  from_email: string;
  direction: string;
  sent_at: string;
  employee_id: string;
  employee_name: string;
  body_preview: string;
};

type DashboardPayload = {
  mailboxes: Mailbox[];
  needs_attention: ConversationRow[];
  conversations: ConversationRow[];
  stats: { total: number; pending: number; missed: number; done: number };
  person_filter_options: { id: string; name: string }[];
  synced_mail: {
    total: number;
    items: SyncedMailItem[];
    limit: number;
    offset: number;
  };
};

type RuntimeStatus = {
  ingestionRunning: boolean;
  lastIngestionStatus: 'success' | 'failed' | 'idle' | string;
  lastIngestionFinishedAt: string | null;
  lastIngestionStartedAt: string | null;
  lastIngestionEmployees: number;
  lastIngestionMessages: number;
  lastIngestionError: string | null;
};

/** Parallel DELETEs (bounded) — faster than strict sequential; progress still updates per completion. */
const BULK_DELETE_CONCURRENCY = 4;

async function bulkDeleteConversationsById(
  ids: string[],
  token: string,
  onProgress: (completed: number) => void,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  let finished = 0;
  const queue = [...ids];

  const bump = () => {
    finished += 1;
    onProgress(finished);
  };

  async function worker() {
    while (queue.length > 0) {
      const conversationId = queue.shift()!;
      try {
        const res = await apiFetch(
          `/conversations/${encodeURIComponent(conversationId)}`,
          token,
          { method: 'DELETE' },
        );
        if (res.ok) ok += 1;
        else fail += 1;
      } catch {
        // Network/CORS failures should count as failed rows, not crash the whole bulk run.
        fail += 1;
      } finally {
        bump();
      }
    }
  }

  const workers = Math.min(BULK_DELETE_CONCURRENCY, Math.max(1, ids.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { ok, fail };
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

/** Relative time on the first line, locale date + time on the second (for tables). */
function RelWithAbsoluteDate({ iso }: { iso: string | null | undefined }): ReactNode {
  const abs = absoluteTime(iso);
  return (
    <div className="flex flex-col gap-0.5">
      <span>{relativeTime(iso)}</span>
      {abs ? (
        <span className="text-[10px] leading-snug text-slate-400 tabular-nums">{abs}</span>
      ) : null}
    </div>
  );
}

/** Primary line for tables: AI/thread summary, or a readable fallback. */
function conversationDisplayTitle(c: ConversationRow): string {
  const s = (c.summary ?? '').trim();
  if (s.length > 0) return s;
  const cn = (c.client_name ?? '').trim();
  const ce = (c.client_email ?? '').trim();
  if (cn && cn !== ce) return `Thread with ${cn}`;
  if (ce) return `Thread with ${ce}`;
  if (cn) return `Thread with ${cn}`;
  return '(Open in Gmail to see subject)';
}

/** Secondary line: who the thread is with — real name preferred over raw email address. */
function conversationSenderLabel(c: ConversationRow): string {
  const cn = (c.client_name ?? '').trim();
  const ce = (c.client_email ?? '').trim();
  if (cn && cn !== ce) return `${cn} · ${ce}`;
  if (ce) return ce;
  if (cn) return cn;
  return '';
}

/** One Gmail message the historical fetch AI marked relevant (streamed before DB row exists). */
type HistoricalStreamPick = {
  subject: string;
  reason: string | null;
  index: number;
  messageId?: string;
  threadId?: string;
  direction?: 'INBOUND' | 'OUTBOUND';
  sentAtIso?: string;
  fromName?: string | null;
  fromEmail?: string;
  userCcOnly?: boolean;
};

function HistoricalStreamPickCard({ p, isLatest }: { p: HistoricalStreamPick; isLatest?: boolean }) {
  const isOut = p.direction === 'OUTBOUND';
  const senderLine =
    isOut && p.fromEmail
      ? `From your mailbox · ${p.fromEmail}`
      : p.fromName && p.fromEmail && p.fromName !== p.fromEmail
        ? `${p.fromName} · ${p.fromEmail}`
        : p.fromEmail || p.fromName || '—';

  const gmailThreadUrl =
    p.threadId != null && p.threadId.length > 0
      ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(p.threadId)}`
      : null;

  const msgTail =
    p.messageId && p.messageId.length > 14 ? `…${p.messageId.slice(-12)}` : (p.messageId ?? '');
  const threadTail =
    p.threadId && p.threadId.length > 12 ? `…${p.threadId.slice(-10)}` : (p.threadId ?? '');

  return (
    <li
      className={`historical-pick-row-enter rounded-lg border border-white/80 bg-white/90 px-2.5 py-2.5 text-xs shadow-sm ${
        isLatest ? 'ring-1 ring-emerald-200/80' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-900">
          AI kept
        </span>
        {isOut ? (
          <span className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-900">
            Your send
          </span>
        ) : (
          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
            Client mail
          </span>
        )}
        {p.userCcOnly ? (
          <span
            className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800"
            title="You were only on Cc on this inbound (not To) — same as Live CC’d tab"
          >
            CC
          </span>
        ) : null}
        <span className="ml-auto shrink-0 tabular-nums text-[10px] font-semibold text-slate-400">
          #{p.index} of batch
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 font-semibold leading-snug text-slate-900" title={p.subject}>
        {p.subject}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-600 line-clamp-2" title={senderLine}>
        {senderLine}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        {p.messageId ? (
          <span className="font-mono" title={p.messageId}>
            Msg id {msgTail}
          </span>
        ) : null}
        {p.threadId ? (
          <span className="font-mono" title={p.threadId}>
            Thread {threadTail}
          </span>
        ) : null}
        {p.sentAtIso ? (
          <span className="text-slate-600">
            <RelWithAbsoluteDate iso={p.sentAtIso} />
          </span>
        ) : null}
        {gmailThreadUrl ? (
          <a
            href={gmailThreadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-brand-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Open in Gmail
          </a>
        ) : null}
      </div>
      {p.reason ? (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-snug text-slate-600 line-clamp-4">
          {p.reason}
        </p>
      ) : null}
    </li>
  );
}

function ConversationSubjectCell({ c }: { c: ConversationRow }) {
  const title = conversationDisplayTitle(c);
  const sender = conversationSenderLabel(c);
  const sub = (c.short_reason ?? '').trim();
  const showSub = sub.length > 0 && sub !== title;
  return (
    <td className="max-w-[min(28rem,45vw)] px-4 py-3 align-top text-slate-700">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium leading-snug text-slate-900 line-clamp-2" title={title}>
          {title}
        </span>
        {c.user_cc_only ? (
          <span
            className="shrink-0 rounded-md bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800"
            title="You were only on Cc on the latest inbound (not To)"
          >
            CC
          </span>
        ) : null}
      </div>
      {sender ? (
        <div className="mt-0.5 text-[11px] leading-snug text-slate-500 line-clamp-1" title={sender}>
          {sender}
        </div>
      ) : null}
      {showSub ? (
        <div
          className="mt-0.5 text-[11px] leading-snug text-slate-400 line-clamp-2"
          title={sub}
        >
          {sub}
        </div>
      ) : null}
    </td>
  );
}

function formatLocalYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Start/end of local calendar days as ISO strings for the historical missed API. */
function localYmdRangeToIsoBounds(
  startYmd: string,
  endYmd: string,
): { startIso: string; endIso: string } | null {
  if (!startYmd.trim() || !endYmd.trim()) return null;
  const start = new Date(`${startYmd.trim()}T00:00:00`);
  const end = new Date(`${endYmd.trim()}T23:59:59.999`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** `datetime-local` value in the user's local timezone */
function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatElapsedSince(startedAtMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

/** Latest `last_synced_at` among mailboxes (server’s last Gmail + processing pass for that row). */
function pickLatestMailboxSyncIso(mailboxes: Mailbox[]): string | null {
  let best = -1;
  let iso: string | null = null;
  for (const m of mailboxes) {
    const raw = m.last_synced_at;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t > best) {
      best = t;
      iso = raw;
    }
  }
  return iso;
}

function formatLiveSyncRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Unknown';
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 15) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatLiveSyncAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** CEO Live Mails: friendly last-sync timer + exact date (from mailbox `last_synced_at`). */
function LiveMailSyncBanner({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  void tick;
  const nowMs = Date.now();
  const connected = mailboxes.some((m) => m.gmail_connected);
  const latestIso = pickLatestMailboxSyncIso(mailboxes);

  if (!connected) {
    return (
      <div className="mb-6 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-4 py-3 sm:px-5">
        <p className="text-sm font-medium text-slate-700">Live mail sync</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Connect Gmail on your inbox card below — then you&apos;ll see when the last Gmail + AI sync finished.
        </p>
      </div>
    );
  }

  if (!latestIso) {
    return (
      <div className="mb-6 rounded-2xl border border-amber-200/80 bg-amber-50/50 px-4 py-3 sm:px-5">
        <p className="text-sm font-semibold text-amber-950">Live mail sync</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
          Gmail is connected. The first sync is starting — refresh in a moment to see the last run time.
        </p>
      </div>
    );
  }

  const relative = formatLiveSyncRelative(latestIso, nowMs);
  const absolute = formatLiveSyncAbsolute(latestIso);
  const ageMin = (nowMs - Date.parse(latestIso)) / 60_000;
  const looksFresh = ageMin < 20;

  return (
    <div className="mb-6 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/90 via-white to-slate-50/60 px-4 py-3.5 shadow-sm sm:px-5 sm:py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-start gap-3">
          <div
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"
            aria-hidden
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path
                fillRule="evenodd"
                d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-900">Last Gmail &amp; AI sync</p>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  looksFresh ? 'bg-emerald-200/80 text-emerald-900' : 'bg-slate-200/80 text-slate-600'
                }`}
              >
                {looksFresh ? 'Recent' : 'Idle'}
              </span>
            </div>
            <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900" title={absolute}>
              {relative}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{absolute}</p>
          </div>
        </div>
        <p className="max-w-sm text-[11px] leading-relaxed text-slate-500 sm:text-right">
          Live mail checks Gmail on a schedule, then runs AI on new messages. This time updates after each successful run
          (refresh the page if you&apos;ve been away a while).
        </p>
      </div>
    </div>
  );
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    MISSED: 'bg-red-100 text-red-800',
    PENDING: 'bg-amber-100 text-amber-800',
    DONE: 'bg-emerald-100 text-emerald-800',
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? 'bg-slate-100 text-slate-700'}`}
    >
      {status}
    </span>
  );
}

function priorityDot(p: string) {
  const cls =
    p === 'HIGH'
      ? 'bg-red-500'
      : p === 'MEDIUM'
        ? 'bg-amber-400'
        : 'bg-slate-300';
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} title={p} />;
}

function MyEmailPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { me, token, loading: authLoading, signOut: ctxSignOut } = useAuth();

  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Add mailbox form
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  /** Sidebar hash drives separate screens — CEO inbox is not one long scroll with manager/team below. */
  const [myEmailTab, setMyEmailTab] = useState<'ceo' | 'manager' | 'team'>('ceo');

  /** CEO inbox only: live feed vs past missed search (does not affect Manager / Team tabs). */
  const [ceoInboxMode, setCeoInboxMode] = useState<'live' | 'historical'>('live');
  const [histStartDate, setHistStartDate] = useState('');
  const [histEndDate, setHistEndDate] = useState('');
  const [historicalRows, setHistoricalRows] = useState<ConversationRow[]>([]);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const [historicalSearched, setHistoricalSearched] = useState(false);
  const [historicalStats, setHistoricalStats] = useState<{
    fetched_from_gmail: number;
    stored_relevant: number;
    skipped_irrelevant: number;
    conversations_created: number;
  } | null>(null);

  /** Live SSE progress for Historical Search (totals, AI step, lazy “kept” list). */
  const [histLive, setHistLive] = useState<{
    phase: 'idle' | 'listed' | 'ai' | 'saving' | 'recomputing' | 'done' | 'error';
    gmailListDone: boolean;
    listedTotal: number;
    currentIndex: number;
    total: number;
    picks: HistoricalStreamPick[];
    relevantSoFar: number;
  }>({
    phase: 'idle',
    gmailListDone: false,
    listedTotal: 0,
    currentIndex: 0,
    total: 0,
    picks: [],
    relevantSoFar: 0,
  });

  /** Wall-clock seconds while Historical Search is running (drives live timer in UI). */
  const [histElapsedSec, setHistElapsedSec] = useState(0);

  /** Abort in-flight `historical-fetch-stream` (Stop button). */
  const historicalFetchAbortRef = useRef<AbortController | null>(null);
  const [histDeletingAll, setHistDeletingAll] = useState(false);
  const [histRowDeletingId, setHistRowDeletingId] = useState<string | null>(null);

  const [filterMailbox, setFilterMailbox] = useState('');
  /** Extra filters only for the “All threads” tab. */
  const [allTabStatus, setAllTabStatus] = useState('');
  const [allTabPriority, setAllTabPriority] = useState('');

  const [mailTab, setMailTab] = useState<MailTab>('action');
  const [mailListPage, setMailListPage] = useState(1);
  const [threadSearch, setThreadSearch] = useState('');

  // Deletion
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [slaDraftById, setSlaDraftById] = useState<Record<string, string>>({});
  const [slaSavingId, setSlaSavingId] = useState<string | null>(null);

  const [togglePauseLoadingId, setTogglePauseLoadingId] = useState<string | null>(null);
  const [operationStartingId, setOperationStartingId] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<{
    mailboxId: string;
    trackingStartAt: string | null;
    startedAt: number;
    running: boolean;
    status: 'running' | 'success' | 'failed';
    lastEmployees: number;
    lastMessages: number;
    lastError: string | null;
    finishedAt: string | null;
    /** When the server last marked ingestion as running (ISO) — from `/settings/runtime` while syncing. */
    ingestionStartedAtServer: string | null;
  } | null>(null);
  /** Ticks every 1s while `pipeline.running` so elapsed time in the live panel updates. */
  const [pipelineRunTick, setPipelineRunTick] = useState(0);

  /** CEO must confirm before ingest when Inbox AI cannot classify (settings / key / mailbox AI off). */
  const [ingestWithoutAiPrompt, setIngestWithoutAiPrompt] = useState<{
    mb: Mailbox;
    trackingIso: string;
    slaHours: number;
    blockers: string[];
  } | null>(null);
  const [ingestConfirmLoading, setIngestConfirmLoading] = useState(false);

  /** Hide LOW-priority threads from primary tabs (still visible under Low / noise). */
  const [hideLowPriority, setHideLowPriority] = useState(true);
  /** Bulk delete selection for the active mail tab list. */
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  /** Center-screen modal: deleting (progress) then refreshing dashboard. */
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{
    stage: 'deleting' | 'refreshing';
    done: number;
    total: number;
  } | null>(null);
  const bulkBusy = bulkDeleteProgress != null;
  const bulkPrimaryActionLabel =
    !bulkBusy || !bulkDeleteProgress
      ? null
      : bulkDeleteProgress.stage === 'refreshing'
        ? 'Refreshing…'
        : 'Deleting…';

  /** Latest mailbox filter for stable `loadDashboard`. Person scope hits the API (`mailbox_id` / `sync_employee_ids`); tab + search compose on the client against that payload. */
  const filterRef = useRef({ mailbox: filterMailbox });
  filterRef.current = { mailbox: filterMailbox };

  /** After first successful load for this user, filter-only refetches skip the page skeleton. */
  const dashboardLoadedForUserId = useRef<string | null>(null);

  const loadDashboard = useCallback(async (t: string, syncEmployeeIds?: string) => {
    const f = filterRef.current;
    const qs = new URLSearchParams();
    if (f.mailbox) qs.set('mailbox_id', f.mailbox);
    if (syncEmployeeIds) qs.set('sync_employee_ids', syncEmployeeIds);
    const q = qs.toString();
      const res = await apiFetch(
      `/self-tracking/dashboard${q ? `?${q}` : ''}`,
      t,
    );
    if (!res.ok) {
      setError(await readApiErrorMessage(res, 'Could not load mailbox data.'));
      setDash(null);
      return;
    }
    const body = (await res.json()) as DashboardPayload;
    setDash({
      ...body,
      synced_mail: body.synced_mail ?? {
        total: 0,
        items: [],
        limit: 200,
        offset: 0,
      },
    });
    setError(null);
  }, []);

  const resolveConversation = useCallback(
    async (conversationId: string) => {
      if (!token) return;
      setResolvingId(conversationId);
      setError(null);
      try {
        const res = await apiFetch(
          `/conversations/${encodeURIComponent(conversationId)}/mark-done`,
          token,
          { method: 'POST' },
        );
        if (!res.ok) {
          setError(await readApiErrorMessage(res, 'Could not mark resolved.'));
          return;
        }
        await loadDashboard(token);
        setSuccess('Marked resolved.');
      } finally {
        setResolvingId(null);
      }
    },
    [token, loadDashboard],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!me || !token) {
      dashboardLoadedForUserId.current = null;
      router.replace('/auth');
      return;
    }
    if (me.role === 'PLATFORM_ADMIN') {
      router.replace('/admin');
      return;
    }
    /** My Email is CEO-only — managers and employees use Dashboard / their tools. */
    if (me.role !== 'CEO') {
      router.replace('/dashboard');
      return;
    }

    const showFullPageLoad = dashboardLoadedForUserId.current !== me.id;
    let cancelled = false;

    const run = async () => {
      if (showFullPageLoad) setLoading(true);
      try {
        await loadDashboard(token);
        if (!cancelled) {
          dashboardLoadedForUserId.current = me.id;
        }
      } finally {
        if (!cancelled && showFullPageLoad) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [authLoading, me, token, router, loadDashboard]);

  useEffect(() => {
    const syncTab = () => {
      const h = typeof window !== 'undefined' ? window.location.hash : '';
      if (h === '#manager-mailboxes') setMyEmailTab('manager');
      else if (h === '#team-mailboxes-ceo') setMyEmailTab('team');
      else setMyEmailTab('ceo');
    };
    syncTab();
    window.addEventListener('hashchange', syncTab);
    return () => window.removeEventListener('hashchange', syncTab);
  }, []);

  useEffect(() => {
    if (myEmailTab !== 'team') setShowAddForm(false);
  }, [myEmailTab]);

  useEffect(() => {
    if (myEmailTab !== 'ceo') {
      setCeoInboxMode('live');
      setHistoricalSearched(false);
      setHistoricalRows([]);
      setHistoricalStats(null);
      setHistLive({
        phase: 'idle',
        gmailListDone: false,
        listedTotal: 0,
        currentIndex: 0,
        total: 0,
        picks: [],
        relevantSoFar: 0,
      });
    }
  }, [myEmailTab]);

  useEffect(() => {
    if (!historicalLoading) {
      setHistElapsedSec(0);
      return;
    }
    const started = Date.now();
    setHistElapsedSec(0);
    const id = window.setInterval(() => {
      setHistElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 400);
    return () => clearInterval(id);
  }, [historicalLoading]);

  useEffect(() => {
    setFilterMailbox('');
  }, [myEmailTab]);

  // Handle OAuth redirect back
  useEffect(() => {
    if (authLoading || !token) return;
    const oauthErr = searchParams.get('oauth_error');
    const connected = searchParams.get('connected');
    if (!oauthErr && connected !== '1') return;

    if (oauthErr) setError(oauthErrorMessage(oauthErr));
    if (connected === '1') {
      setSuccess('Gmail connected successfully.');
      void loadDashboard(token);
    }

    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['oauth_error', 'connected', 'employee_id'])
      params.delete(k);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [authLoading, token, searchParams, pathname, router, loadDashboard]);

  // Auto-clear success after 4s
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  async function connectGmail(mailboxId: string) {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    const res = await apiFetch(
      `/auth/gmail/authorize-url?employee_id=${encodeURIComponent(mailboxId)}`,
      session.access_token,
    );
    const body = (await res.json().catch(() => ({}))) as {
      url?: string;
      message?: string;
    };
    if (!res.ok || !body.url) {
      setError(body.message || 'Could not start Google connection');
      return;
    }
    window.location.href = body.url;
  }

  /** CEO’s own mailbox only — uses session profile; also sends name/email so older APIs still work. */
  async function connectMyInbox() {
    if (!token || !me) return;
    const profileEmail = (me.email ?? '').trim();
    if (!profileEmail) {
      setError('Your profile has no email address. Update it in Settings or contact support.');
      return;
    }
    const profileName =
      (me.full_name ?? '').trim() ||
      profileEmail.split('@')[0] ||
      'Me';

    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch('/self-tracking/mailboxes', token, {
        method: 'POST',
        body: JSON.stringify({
          use_my_profile: true,
          name: profileName,
          email: profileEmail,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not set up your mailbox',
        );
        return;
      }
      const data = (await res.json()) as { mailbox?: { id: string } };
      const id = data.mailbox?.id;
      if (id) {
        setSuccess('Opening Google to connect your inbox…');
        await connectGmail(id);
        return;
      }
      setError('Could not create your mailbox');
    } finally {
      setAdding(false);
    }
  }

  async function addMailbox() {
    if (!token) return;
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch('/self-tracking/mailboxes', token, {
        method: 'POST',
        body: JSON.stringify({ name: addName.trim(), email: addEmail.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not add mailbox',
        );
        return;
      }
      setAddName('');
      setAddEmail('');
      setShowAddForm(false);
      setSuccess('Mailbox added. Connect Gmail to start tracking.');
      await loadDashboard(token);
    } finally {
      setAdding(false);
    }
  }

  async function removeMailbox(id: string) {
    if (!token) return;
    if (
      !window.confirm('Remove this tracked mailbox and all its conversations?')
    )
      return;
    setDeletingId(id);
    try {
      const res = await apiFetch(
        `/self-tracking/mailboxes/${encodeURIComponent(id)}`,
        token,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(
          (j as { message?: string }).message ?? 'Could not remove mailbox',
        );
        return;
      }
      setSuccess('Mailbox removed.');
      await loadDashboard(token);
    } finally {
      setDeletingId(null);
    }
  }

  const ceoEmailNorm = me?.email?.trim().toLowerCase() ?? '';

  function mailboxSlaInputValue(mb: Mailbox): string {
    if (slaDraftById[mb.id] !== undefined) return slaDraftById[mb.id];
    return String(
      mb.sla_hours_default != null && mb.sla_hours_default > 0
        ? mb.sla_hours_default
        : effectiveMailboxSlaHours(mb),
    );
  }

  async function saveMailboxSla(mb: Mailbox) {
    if (!token) return;
    setError(null);
    const raw = mailboxSlaInputValue(mb).trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > 168) {
      setError('Response-time target must be between 1 and 168 hours.');
      return;
    }
    setSlaSavingId(mb.id);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/sla`,
        token,
        { method: 'PATCH', body: JSON.stringify({ sla_hours: value }) },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not save SLA');
        return;
      }
      setSlaDraftById((prev) => {
        const next = { ...prev };
        delete next[mb.id];
        return next;
      });
      setSuccess(`Saved ${value}h response-time target for this inbox.`);
      await loadDashboard(token);
    } finally {
      setSlaSavingId(null);
    }
  }

  async function toggleTrackingPause(mb: Mailbox, pause: boolean) {
    if (!token) return;
    setTogglePauseLoadingId(mb.id);
    setError(null);
    try {
      const res = await apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/tracking-pause`,
        token,
        { method: 'PATCH', body: JSON.stringify({ paused: pause }) },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { message?: string }).message ?? 'Could not update tracking status');
        return;
      }
      setSuccess(pause ? 'Tracking paused.' : 'Tracking enabled — live monitoring is ON.');
      await loadDashboard(token);
    } finally {
      setTogglePauseLoadingId(null);
    }
  }

  async function runMailboxPipelineCore(
    mb: Mailbox,
    selectedTrackingIso: string,
    slaRounded: number,
  ) {
    if (!token) return;

    const [trackingRes, slaRes] = await Promise.all([
      apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/tracking-start`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ tracking_start_at: selectedTrackingIso }),
        },
      ),
      apiFetch(
        `/employees/${encodeURIComponent(mb.id)}/sla`,
        token,
        { method: 'PATCH', body: JSON.stringify({ sla_hours: slaRounded }) },
      ),
    ]);

    if (!trackingRes.ok) {
      const j = await trackingRes.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Could not save tracking date/time.');
      return;
    }
    if (!slaRes.ok) {
      const j = await slaRes.json().catch(() => ({}));
      setError((j as { message?: string }).message ?? 'Could not save SLA hours.');
      return;
    }

    setSlaDraftById((prev) => {
      const next = { ...prev };
      delete next[mb.id];
      return next;
    });

    const basePipeline = {
      mailboxId: mb.id,
      trackingStartAt: selectedTrackingIso,
      startedAt: Date.now(),
      lastEmployees: 0,
      lastMessages: 0,
      lastError: null as string | null,
      finishedAt: null as string | null,
      ingestionStartedAtServer: null as string | null,
    };

    setPipeline({
      ...basePipeline,
      running: true,
      status: 'running',
    });
    setOperationStartingId(null);
    setSuccess(
      'Sync running — use the progress card below. Large inboxes can take several minutes; elapsed time updates every second.',
    );

    const runRes = await apiFetch('/email-ingestion/run', token);
    const runBody = (await runRes.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      reason?: string;
    };

    if (!runRes.ok) {
      setPipeline(null);
      setError(runBody.message ?? 'Could not start mailbox operation right now.');
      return;
    }

    if (runBody.status === 'skipped') {
      setPipeline(null);
      setError(
        runBody.message ??
          'Mailbox crawl is off in Settings. Turn it on under Settings, then try Start again.',
      );
      return;
    }

    if (runBody.status === 'completed') {
      const rtRes = await apiFetch('/settings/runtime', token);
      if (rtRes.ok) {
        const rt = (await rtRes.json()) as RuntimeStatus;
        const failed = rt.lastIngestionStatus === 'failed';
        setPipeline({
          ...basePipeline,
          running: false,
          status: failed ? 'failed' : 'success',
          lastEmployees: Number(rt.lastIngestionEmployees ?? 0),
          lastMessages: Number(rt.lastIngestionMessages ?? 0),
          lastError: rt.lastIngestionError ?? null,
          finishedAt: rt.lastIngestionFinishedAt ?? new Date().toISOString(),
          ingestionStartedAtServer: rt.lastIngestionStartedAt ?? null,
        });
        setSuccess(
          failed
            ? 'Ingestion finished with errors. Check the pipeline message below or Settings → diagnostics.'
            : 'Ingestion finished. Your inbox list updates below as threads are processed.',
        );
      } else {
        setPipeline({
          ...basePipeline,
          running: false,
          status: 'success',
          finishedAt: new Date().toISOString(),
        });
        setSuccess('Ingestion completed. Your inbox list updates below as threads are processed.');
      }
    } else if (runBody.status === 'running') {
      setSuccess('Another sync is already in progress; this page will update when it finishes.');
    } else {
      setPipeline(null);
      setError(
        runBody.message ??
          'Unexpected response from the server after starting sync. Try again or open Settings → diagnostics.',
      );
      return;
    }

    await loadDashboard(token, mb.id);
  }

  async function confirmIngestWithoutAi() {
    if (!token || !ingestWithoutAiPrompt) return;
    setIngestConfirmLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/settings', token, {
        method: 'PUT',
        body: JSON.stringify({
          key: 'email_ingest_without_ai_confirmed',
          value: 'true',
        }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not save confirmation.'));
        return;
      }
      const payload = ingestWithoutAiPrompt;
      setIngestWithoutAiPrompt(null);
      setOperationStartingId(payload.mb.id);
      try {
        await runMailboxPipelineCore(payload.mb, payload.trackingIso, payload.slaHours);
      } catch {
        setPipeline(null);
        setError('Could not start mailbox operation due to a network or server error.');
      }
    } finally {
      setIngestConfirmLoading(false);
      setOperationStartingId(null);
    }
  }

  async function startMailboxOperation(mb: Mailbox) {
    if (!token) return;

    const selectedTrackingIso = mb.tracking_start_at ?? new Date().toISOString();

    const slaRaw = mailboxSlaInputValue(mb).trim();
    const slaValue = Number(slaRaw);
    const slaRounded = Number.isFinite(slaValue) && slaValue >= 1 && slaValue <= 168
      ? Math.round(slaValue)
      : 24;

    setOperationStartingId(mb.id);
    setError(null);
    setSuccess(null);

    try {
      const settingsRes = await apiFetch('/settings', token);
      if (!settingsRes.ok) {
        setError(await readApiErrorMessage(settingsRes, 'Could not load settings.'));
        return;
      }
      const rawSettings = (await settingsRes.json()) as Record<string, unknown>;
      const aiS = normalizeIngestAiSettings(rawSettings);
      const blockers = getInboxAiBlockers(aiS, mb);
      if (blockers.length > 0 && !aiS.email_ingest_without_ai_confirmed) {
        setIngestWithoutAiPrompt({
          mb,
          trackingIso: selectedTrackingIso,
          slaHours: slaRounded,
          blockers,
        });
        return;
      }

      try {
        await runMailboxPipelineCore(mb, selectedTrackingIso, slaRounded);
      } catch {
        setPipeline(null);
        setError('Could not start mailbox operation due to a network or server error.');
      }
    } catch {
      setError('Could not start mailbox operation.');
    } finally {
      setOperationStartingId(null);
    }
  }

  useEffect(() => {
    if (!pipeline?.running) return;
    const id = window.setInterval(() => {
      setPipelineRunTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [pipeline?.running]);

  useEffect(() => {
    if (!token || !pipeline) return;

    let stopped = false;
    const poll = async () => {
      const res = await apiFetch('/settings/runtime', token);
      if (!res.ok) return;
      const rt = (await res.json()) as RuntimeStatus;
      if (stopped) return;

      if (rt.ingestionRunning) {
        setPipeline((p) =>
          p
            ? {
                ...p,
                running: true,
                status: 'running',
                ingestionStartedAtServer:
                  rt.lastIngestionStartedAt ?? p.ingestionStartedAtServer ?? null,
                /** Totals on the server are only finalized when a run completes; avoid showing stale ones mid-sync. */
              }
            : p,
        );
        return;
      }

      const terminalStatus =
        rt.lastIngestionStatus === 'failed' ? 'failed' : 'success';
      setPipeline((p) =>
        p
          ? {
              ...p,
              running: false,
              status: terminalStatus,
              lastEmployees: Number(rt.lastIngestionEmployees ?? p.lastEmployees),
              lastMessages: Number(rt.lastIngestionMessages ?? p.lastMessages),
              lastError: rt.lastIngestionError ?? null,
              finishedAt: rt.lastIngestionFinishedAt ?? new Date().toISOString(),
              ingestionStartedAtServer:
                rt.lastIngestionStartedAt ?? p.ingestionStartedAtServer ?? null,
            }
          : p,
      );
      if (terminalStatus === 'success') {
        void loadDashboard(token, pipeline.mailboxId);
      }
    };

    const id = window.setInterval(() => {
      void poll();
    }, 1500);
    void poll();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [token, pipeline?.mailboxId]);

  // Filtered conversations from the dashboard payload
  const conversations = useMemo(
    () => dash?.conversations ?? [],
    [dash],
  );
  const stats = dash?.stats ?? { total: 0, pending: 0, missed: 0, done: 0 };
  /** Stable when `dash` is null — avoids new `[]` each render (which blew up selection-prune effects). */
  const mailboxes = useMemo(() => dash?.mailboxes ?? [], [dash]);
  const personOptions = dash?.person_filter_options ?? [];

  /**
   * Your inbox = every mailbox whose **email matches your CEO login** — whether it was created as
   * self-tracking (Connect my Gmail) or as a team/org row (Employees). Same address always lists here.
   */
  const ownMailboxes = useMemo(
    () =>
      mailboxes.filter(
        (mb) =>
          ceoEmailNorm !== '' &&
          mb.email.trim().toLowerCase() === ceoEmailNorm,
      ),
    [mailboxes, ceoEmailNorm],
  );

  const refreshHistoricalWindowTable = useCallback(async (): Promise<ConversationRow[]> => {
    if (!token) return [];
    const bounds = localYmdRangeToIsoBounds(histStartDate, histEndDate);
    if (!bounds) return [];
    const targetMailboxId = ownMailboxes.length > 0 ? ownMailboxes[0].id : '';
    if (!targetMailboxId) return [];
    const params = new URLSearchParams({
      start: bounds.startIso,
      end: bounds.endIso,
      employee_id: targetMailboxId,
    });
    const res = await apiFetch(`/self-tracking/historical-window-results?${params}`, token);
    if (!res.ok) {
      throw new Error(await readApiErrorMessage(res, 'Could not refresh historical results.'));
    }
    const data = (await res.json()) as { conversations?: ConversationRow[] };
    const conv = data.conversations ?? [];
    setHistoricalRows(conv);
    return conv;
  }, [token, histStartDate, histEndDate, ownMailboxes]);

  const searchHistoricalFetch = useCallback(async () => {
    if (!token) return;
    const bounds = localYmdRangeToIsoBounds(histStartDate, histEndDate);
    if (!bounds) {
      setError('Select a valid start and end date.');
      return;
    }

    /** Same mailbox row as Live Mails — CEO login inbox only, no picker. */
    const targetMailboxId = ownMailboxes.length > 0 ? ownMailboxes[0].id : '';
    if (!targetMailboxId) {
      setError('Connect your CEO inbox under My Email (Live Mails) first.');
      return;
    }

    setHistoricalLoading(true);
    setHistoricalStats(null);
    setHistoricalRows([]);
    setError(null);
    setSuccess(null);
    setHistLive({
      phase: 'listed',
      gmailListDone: false,
      listedTotal: 0,
      currentIndex: 0,
      total: 0,
      picks: [],
      relevantSoFar: 0,
    });

    historicalFetchAbortRef.current?.abort();
    const ac = new AbortController();
    historicalFetchAbortRef.current = ac;

    try {
      await apiPostSse(
        '/self-tracking/historical-fetch-stream',
        token,
        {
          start: bounds.startIso,
          end: bounds.endIso,
          employee_id: targetMailboxId,
        },
        (ev) => {
          const phase = ev.phase as string | undefined;
          if (phase === 'listed') {
            const n = Number(ev.totalIds ?? 0);
            setHistLive((prev) => ({
              ...prev,
              phase: 'listed',
              gmailListDone: true,
              listedTotal: n,
              total: n,
            }));
            return;
          }
          if (phase === 'message') {
            const index = Number(ev.index ?? 0);
            const total = Number(ev.total ?? 0);
            setHistLive((prev) => ({
              ...prev,
              phase: 'ai',
              currentIndex: index,
              total: total || prev.total,
            }));
            return;
          }
          if (phase === 'ai_decision') {
            const index = Number(ev.index ?? 0);
            const total = Number(ev.total ?? 0);
            const relevant = Boolean(ev.relevant);
            const subject = String(ev.subject ?? '');
            const reason = ev.reason != null ? String(ev.reason) : null;
            const messageId =
              typeof ev.message_id === 'string' && ev.message_id.trim() ? ev.message_id.trim() : undefined;
            const threadId =
              typeof ev.thread_id === 'string' && ev.thread_id.trim() ? ev.thread_id.trim() : undefined;
            const direction: 'INBOUND' | 'OUTBOUND' | undefined =
              ev.direction === 'OUTBOUND'
                ? 'OUTBOUND'
                : ev.direction === 'INBOUND'
                  ? 'INBOUND'
                  : undefined;
            const sentAtIso =
              typeof ev.sent_at_iso === 'string' && ev.sent_at_iso.trim()
                ? ev.sent_at_iso.trim()
                : undefined;
            const fromName =
              ev.from_name != null && String(ev.from_name).trim() ? String(ev.from_name).trim() : null;
            const fromEmail = typeof ev.from === 'string' && ev.from.trim() ? ev.from.trim() : undefined;
            const userCcOnly = ev.user_cc_only === true;
            setHistLive((prev) => {
              const picks =
                relevant && subject
                  ? [
                      ...prev.picks,
                      {
                        subject,
                        reason,
                        index,
                        messageId,
                        threadId,
                        direction,
                        sentAtIso,
                        fromName,
                        fromEmail,
                        userCcOnly,
                      },
                    ].slice(-400)
                  : prev.picks;
              return {
                ...prev,
                phase: 'ai',
                currentIndex: index,
                total,
                picks,
                relevantSoFar: relevant ? prev.relevantSoFar + 1 : prev.relevantSoFar,
              };
            });
            return;
          }
          if (phase === 'saving') {
            setHistLive((prev) => ({ ...prev, phase: 'saving' }));
            return;
          }
          if (phase === 'recomputing') {
            setHistLive((prev) => ({ ...prev, phase: 'recomputing' }));
            return;
          }
          if (phase === 'complete') {
            const result = ev.result as
              | {
                  conversations?: ConversationRow[];
                  fetched_from_gmail?: number;
                  stored_relevant?: number;
                  skipped_irrelevant?: number;
                  conversations_created?: number;
                  stopped?: boolean;
                }
              | undefined;
            const conv = result?.conversations ?? [];
            setHistoricalRows(conv);
            setHistoricalStats({
              fetched_from_gmail: result?.fetched_from_gmail ?? 0,
              stored_relevant: result?.stored_relevant ?? 0,
              skipped_irrelevant: result?.skipped_irrelevant ?? 0,
              conversations_created: result?.conversations_created ?? 0,
            });
            setHistoricalSearched(true);
            setHistLive((prev) => ({ ...prev, phase: 'done' }));
            if (result?.stopped) {
              setSuccess(
                conv.length > 0
                  ? `Stopped — saved ${result.stored_relevant ?? 0} relevant message(s). Showing ${conv.length} thread(s) in this date range.`
                  : 'Stopped — any messages already classified were saved.',
              );
            } else if (conv.length > 0) {
              setSuccess(`Found ${conv.length} relevant conversation(s) from Gmail.`);
            }
            return;
          }
          if (phase === 'error') {
            setError(String(ev.message ?? 'Historical fetch failed.'));
            setHistLive((prev) => ({ ...prev, phase: 'error' }));
            setHistoricalSearched(true);
          }
        },
        ac.signal,
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        try {
          const conv = await refreshHistoricalWindowTable();
          setHistoricalSearched(true);
          setHistoricalStats(null);
          setHistLive((prev) => ({ ...prev, phase: 'done' }));
          setSuccess(
            conv.length > 0
              ? `Stopped. Partial results were saved — ${conv.length} thread(s) in this date range. You can remove any row below if you don’t want to keep it.`
              : 'Stopped. Any messages already classified were saved. Run fetch again to continue, or change the date range.',
          );
        } catch (refreshErr) {
          setError(
            refreshErr instanceof Error && refreshErr.message.trim()
              ? refreshErr.message
              : 'Stopped, but the list could not be refreshed.',
          );
          setHistLive((prev) => ({ ...prev, phase: 'error' }));
        }
      } else {
        const fallback = formatNetworkFetchFailureMessage();
        setError(e instanceof Error && e.message.trim() ? e.message : fallback);
        setHistoricalRows([]);
        setHistoricalSearched(true);
        setHistLive((prev) => ({ ...prev, phase: 'error' }));
      }
    } finally {
      historicalFetchAbortRef.current = null;
      setHistoricalLoading(false);
    }
  }, [token, histStartDate, histEndDate, ownMailboxes, refreshHistoricalWindowTable]);

  const deleteHistoricalRow = useCallback(
    async (conversationId: string) => {
      if (!token) return;
      if (
        !window.confirm(
          'Remove this thread from the tracker? Stored messages in this thread will be deleted from the app.',
        )
      ) {
        return;
      }
      setHistRowDeletingId(conversationId);
      setError(null);
      try {
        const res = await apiFetch(
          `/conversations/${encodeURIComponent(conversationId)}`,
          token,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          setError(await readApiErrorMessage(res, 'Could not remove thread.'));
          return;
        }
        setHistoricalRows((rows) => rows.filter((c) => c.conversation_id !== conversationId));
        setSuccess('Thread removed from the tracker.');
      } finally {
        setHistRowDeletingId(null);
      }
    },
    [token],
  );

  const deleteAllHistoricalResults = useCallback(async () => {
    if (!token || historicalRows.length === 0) return;
    if (
      !window.confirm(
        `Remove all ${historicalRows.length} threads shown from this search from the tracker? Stored email for those threads will be deleted.`,
      )
    ) {
      return;
    }
    setHistDeletingAll(true);
    setError(null);
    try {
      const ids = historicalRows.map((c) => c.conversation_id);
      const { ok, fail } = await bulkDeleteConversationsById(ids, token, () => {});
      if (fail > 0) {
        setError(`${fail} thread(s) could not be removed (${ok} removed).`);
        await refreshHistoricalWindowTable().catch(() => {});
      } else {
        setHistoricalRows([]);
        setHistoricalStats(null);
        setSuccess('All listed threads were removed from the tracker.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk delete failed.');
    } finally {
      setHistDeletingAll(false);
    }
  }, [token, historicalRows, refreshHistoricalWindowTable]);

  /** Department managers only — matches HEAD user in org (not every IC). */
  const managerMailboxes = useMemo(
    () =>
      mailboxes.filter((mb) => {
        if (ceoEmailNorm !== '' && mb.email.trim().toLowerCase() === ceoEmailNorm) {
          return false;
        }
        return mb.is_manager_mailbox === true;
      }),
    [mailboxes, ceoEmailNorm],
  );

  /** Individual contributors & other team mailboxes (not the CEO inbox, not a manager row). */
  const teamMailboxesOnly = useMemo(
    () =>
      mailboxes.filter((mb) => {
        if (ceoEmailNorm !== '' && mb.email.trim().toLowerCase() === ceoEmailNorm) {
          return false;
        }
        return mb.is_manager_mailbox !== true;
      }),
    [mailboxes, ceoEmailNorm],
  );

  const scopeMailboxIds = useMemo(() => {
    const ids = new Set<string>();
    if (myEmailTab === 'ceo') {
      ownMailboxes.forEach((m) => ids.add(m.id));
    } else if (myEmailTab === 'manager') {
      managerMailboxes.forEach((m) => ids.add(m.id));
    } else {
      teamMailboxesOnly.forEach((m) => ids.add(m.id));
    }
    return ids;
  }, [myEmailTab, ownMailboxes, managerMailboxes, teamMailboxesOnly]);

  const scopedConversations = useMemo(
    () => conversations.filter((c) => scopeMailboxIds.has(c.employee_id)),
    [conversations, scopeMailboxIds],
  );

  const scopedStats = useMemo(() => {
    const conv = scopedConversations;
    return {
      total: conv.length,
      pending: conv.filter((c) => c.follow_up_status === 'PENDING').length,
      missed: conv.filter((c) => c.follow_up_status === 'MISSED').length,
      done: conv.filter((c) => c.follow_up_status === 'DONE').length,
    };
  }, [scopedConversations]);

  const scopedPersonOptions = useMemo(
    () => personOptions.filter((p) => scopeMailboxIds.has(p.id)),
    [personOptions, scopeMailboxIds],
  );

  const withoutLowScoped = useMemo(
    () =>
      hideLowPriority
        ? scopedConversations.filter((c) => c.priority !== 'LOW')
        : scopedConversations,
    [hideLowPriority, scopedConversations],
  );

  const kpiNeedReplyCount = useMemo(
    () =>
      withoutLowScoped.filter(
        (c) =>
          needsMyReply(c) &&
          (!HIDE_STALE_NEED_REPLY || !isStaleNeedReplyByClientMessage(c, STALE_NEED_REPLY_DAYS)),
      ).length,
    [withoutLowScoped],
  );
  const kpiWaitingCount = useMemo(
    () => withoutLowScoped.filter((c) => isWaitingOnThem(c)).length,
    [withoutLowScoped],
  );

  const ccScopedRows = useMemo(
    () =>
      (hideLowPriority
        ? scopedConversations.filter((c) => c.priority !== 'LOW')
        : scopedConversations
      ).filter((c) => c.user_cc_only === true),
    [hideLowPriority, scopedConversations],
  );

  const tabSourceRows = useMemo(() => {
    switch (mailTab) {
      case 'noise':
        return scopedConversations.filter((c) => c.priority === 'LOW');
      case 'action':
        return withoutLowScoped.filter(
          (c) =>
            needsMyReply(c) &&
            (!HIDE_STALE_NEED_REPLY || !isStaleNeedReplyByClientMessage(c, STALE_NEED_REPLY_DAYS)),
        );
      case 'waiting':
        return withoutLowScoped.filter((c) => isWaitingOnThem(c));
      case 'cc':
        return ccScopedRows;
      case 'closed':
        return scopedConversations.filter((c) => c.follow_up_status === 'DONE');
      case 'all': {
        let rows = hideLowPriority
          ? scopedConversations.filter((c) => c.priority !== 'LOW')
          : scopedConversations;
        if (allTabStatus) rows = rows.filter((c) => c.follow_up_status === allTabStatus);
        if (allTabPriority) rows = rows.filter((c) => c.priority === allTabPriority);
        return rows;
      }
      default:
        return withoutLowScoped;
    }
  }, [
    mailTab,
    scopedConversations,
    withoutLowScoped,
    ccScopedRows,
    hideLowPriority,
    allTabStatus,
    allTabPriority,
  ]);

  const searchFilteredTabRows = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return tabSourceRows;
    return tabSourceRows.filter((c) => {
      const title = conversationDisplayTitle(c).toLowerCase();
      const client = (c.client_email ?? '').toLowerCase();
      const clientName = (c.client_name ?? '').toLowerCase();
      const person = (c.employee_name ?? '').toLowerCase();
      const summary = (c.summary ?? '').toLowerCase();
      const shortReason = (c.short_reason ?? '').toLowerCase();
      const reason = (c.reason ?? '').toLowerCase();
      const threadId = (c.provider_thread_id ?? '').toLowerCase();
      const convId = (c.conversation_id ?? '').toLowerCase();
      return (
        title.includes(q) ||
        client.includes(q) ||
        clientName.includes(q) ||
        person.includes(q) ||
        summary.includes(q) ||
        shortReason.includes(q) ||
        reason.includes(q) ||
        threadId.includes(q) ||
        convId.includes(q)
      );
    });
  }, [tabSourceRows, threadSearch]);

  /** Newest activity first so “Live” isn’t visually dominated by old missed threads (API orders by updated_at). */
  const searchFilteredTabRowsSorted = useMemo(() => {
    const rows = [...searchFilteredTabRows];
    const activityMs = (c: ConversationRow) => {
      const client = c.last_client_msg_at ? new Date(c.last_client_msg_at).getTime() : 0;
      const reply = c.last_employee_reply_at ? new Date(c.last_employee_reply_at).getTime() : 0;
      return Math.max(client, reply);
    };
    rows.sort((a, b) => activityMs(b) - activityMs(a));
    return rows;
  }, [searchFilteredTabRows]);

  const historicalFilteredRows = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return historicalRows;
    return historicalRows.filter((c) => {
      const title = conversationDisplayTitle(c).toLowerCase();
      const client = (c.client_email ?? '').toLowerCase();
      const clientName = (c.client_name ?? '').toLowerCase();
      const person = (c.employee_name ?? '').toLowerCase();
      const summary = (c.summary ?? '').toLowerCase();
      const shortReason = (c.short_reason ?? '').toLowerCase();
      const reason = (c.reason ?? '').toLowerCase();
      return (
        title.includes(q) ||
        client.includes(q) ||
        clientName.includes(q) ||
        person.includes(q) ||
        summary.includes(q) ||
        shortReason.includes(q) ||
        reason.includes(q)
      );
    });
  }, [historicalRows, threadSearch]);

  const pagedTabRows = useMemo(
    () => searchFilteredTabRowsSorted.slice(0, mailListPage * MAIL_PAGE_SIZE),
    [searchFilteredTabRowsSorted, mailListPage],
  );
  const hasMoreTabRows = searchFilteredTabRowsSorted.length > pagedTabRows.length;

  const syncEmployeeIdsParam = useMemo(() => {
    const m = filterMailbox.trim();
    if (m) return m;
    return [...scopeMailboxIds].sort().join(',');
  }, [filterMailbox, scopeMailboxIds]);

  const pipelineStep2Done =
    pipeline != null && (!pipeline.running || pipeline.status !== 'running');
  const pipelineStep3Done = pipeline != null && pipeline.status === 'success';
  const pipelineStep4Done = pipeline != null && pipeline.status === 'success';
  const pipelineProgressPct =
    pipeline == null
      ? 0
      : pipeline.status === 'failed'
        ? 100
        : pipeline.status === 'success'
          ? 100
          : pipelineStep4Done
            ? 100
            : pipelineStep3Done
              ? 85
              : pipelineStep2Done
                ? 60
                : 30;

  useEffect(() => {
    if (!token || !me || me.role !== 'CEO') return;
    const id = window.setTimeout(() => {
      void loadDashboard(token, syncEmployeeIdsParam || undefined);
    }, 180);
    return () => clearTimeout(id);
  }, [token, me, filterMailbox, loadDashboard, syncEmployeeIdsParam, myEmailTab]);

  useEffect(() => {
    setMailListPage(1);
  }, [
    mailTab,
    threadSearch,
    hideLowPriority,
    allTabStatus,
    allTabPriority,
    myEmailTab,
    filterMailbox,
    scopeMailboxIds,
  ]);

  const mailboxesForInboxShortcuts = useMemo(() => {
    if (myEmailTab === 'ceo') return ownMailboxes;
    if (myEmailTab === 'manager') return managerMailboxes;
    return teamMailboxesOnly;
  }, [myEmailTab, ownMailboxes, managerMailboxes, teamMailboxesOnly]);

  useEffect(() => {
    const allowed = new Set(searchFilteredTabRows.map((c) => c.conversation_id));
    setBulkSelected((prev) => {
      let mustPrune = false;
      for (const id of prev) {
        if (!allowed.has(id)) {
          mustPrune = true;
          break;
        }
      }
      if (!mustPrune) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (allowed.has(id)) next.add(id);
      }
      return next;
    });
  }, [searchFilteredTabRows]);

  const allTabRowsSelected =
    searchFilteredTabRows.length > 0 &&
    searchFilteredTabRows.every((c) => bulkSelected.has(c.conversation_id));

  function toggleSelectAllInTab() {
    if (allTabRowsSelected) {
      setBulkSelected(new Set());
    } else {
      setBulkSelected(new Set(searchFilteredTabRows.map((c) => c.conversation_id)));
    }
  }

  async function deleteSelectedInTab() {
    if (!token || bulkSelected.size === 0) return;
    const ids = [...bulkSelected];
    const n = ids.length;
    if (
      !window.confirm(
        `Delete ${n} conversation(s) from the portal?\n\n` +
          'This removes each thread’s SLA row and all stored messages for that thread in this app. Gmail is not changed.\n\n' +
          'This cannot be undone.',
      )
    ) {
      return;
    }
    setBulkDeleteProgress({ stage: 'deleting', done: 0, total: n });
    setError(null);
    try {
      const { ok, fail } = await bulkDeleteConversationsById(ids, token, (done) => {
        setBulkDeleteProgress((p) => (p ? { ...p, done } : null));
      });
      setBulkSelected(new Set());
      if (fail > 0) {
        setError(`Removed ${ok} conversation(s); ${fail} failed. Refresh and try again.`);
      } else {
        setSuccess(
          `Removed ${ok} conversation(s). New mail can create fresh threads after the next sync.`,
        );
      }
      setBulkDeleteProgress((p) =>
        p ? { ...p, stage: 'refreshing', done: p.total } : null,
      );
      await loadDashboard(token, syncEmployeeIdsParam || undefined);
    } finally {
      setBulkDeleteProgress(null);
    }
  }

  if (!me || authLoading) {
    return (
      <AppShell
        role="CEO"
        title="My Email"
        subtitle="Loading..."
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  if (me.role === 'PLATFORM_ADMIN') {
    return (
      <AppShell
        role="PLATFORM_ADMIN"
        title="My Email"
        subtitle="Redirecting…"
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  if (me.role !== 'CEO') {
    return (
      <AppShell
        role={me.role}
        title="My Email"
        subtitle="Redirecting to your workspace…"
        onSignOut={() => void ctxSignOut()}
      >
        <PageSkeleton />
      </AppShell>
    );
  }

  const pageTitle =
    myEmailTab === 'manager'
      ? 'Manager mail'
      : myEmailTab === 'team'
        ? 'Team mail'
        : 'My Email';
  const shellSubtitle =
    myEmailTab === 'ceo'
      ? 'Your CEO inbox only. Gemini reads mail in your tracking window and keeps messages that may need a reply or follow-up.'
      : myEmailTab === 'manager'
        ? 'Department heads’ tracked inboxes.'
        : 'Individual contributors and other org mailboxes (not your CEO login).';

  const bulkDeleteBarPct =
    bulkDeleteProgress == null || bulkDeleteProgress.total <= 0
      ? 0
      : Math.min(
          100,
          Math.round((100 * bulkDeleteProgress.done) / bulkDeleteProgress.total),
        );

  function livePipelineBelowCard(mbId: string): ReactNode {
    if (!pipeline || pipeline.mailboxId !== mbId) return null;
    const serverSyncPhase = pipeline.running && pipeline.status === 'running';
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700 shadow-sm">
        <p className="font-semibold text-slate-900">Live progress pipeline</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Tracking window:{' '}
          {pipeline.trackingStartAt ? absoluteTime(pipeline.trackingStartAt) : 'Not set'}
        </p>
        {serverSyncPhase ? (
          <>
            <p
              className="mt-2 text-[11px] leading-relaxed text-slate-700"
              aria-live="polite"
              data-poll-tick={pipelineRunTick}
            >
              <span className="font-medium text-slate-900 tabular-nums">
                Elapsed {formatElapsedSince(pipeline.startedAt)}
              </span>{' '}
              · The server is syncing{' '}
              <strong className="font-medium text-slate-800">every connected mailbox</strong> for your
              company (not just this card). With several accounts that is often{' '}
              <strong className="font-medium text-slate-800">several minutes to 20+ minutes</strong>,
              depending on inbox size — not a frozen screen.
            </p>
            {pipeline.ingestionStartedAtServer ? (
              <p className="mt-1 text-[10px] text-slate-500 tabular-nums">
                Server run clock started: {absoluteTime(pipeline.ingestionStartedAtServer)}
              </p>
            ) : null}
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
              The old “30%” bar was only a label, not real per-mailbox progress. Below is an activity bar
              that moves while the lock is on; final mailbox and message totals appear when the run
              completes.
            </p>
          </>
        ) : null}
        <div className="mt-2 space-y-1.5">
          <p>1. Start request accepted</p>
          <p>
            {pipelineStep2Done
              ? '2. Gmail sync finished'
              : serverSyncPhase
                ? '2. Gmail sync in progress (all linked mailboxes on the server)...'
                : '2. Gmail sync running...'}
          </p>
          <p
            className={
              serverSyncPhase && !pipelineStep3Done ? 'text-slate-400' : undefined
            }
          >
            {pipelineStep3Done
              ? '3. Gemini inbox classification completed'
              : serverSyncPhase
                ? '3. Gemini classifies each message (with thread context) as mail is ingested'
                : '3. Gemini inbox classification...'}
          </p>
          <p
            className={
              serverSyncPhase && !pipelineStep4Done ? 'text-slate-400' : undefined
            }
          >
            {pipelineStep4Done
              ? '4. Portal threads refreshed'
              : serverSyncPhase
                ? '4. Thread list refreshes after sync finishes'
                : '4. Updating portal threads...'}
          </p>
        </div>
        <div className="mt-3">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/80">
            {serverSyncPhase ? (
              <div className="relative h-full w-full overflow-hidden rounded-full bg-emerald-400/40">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 animate-bulk-delete-sheen"
                >
                  <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-white/55 to-transparent" />
                </div>
              </div>
            ) : (
              <div
                className={`relative h-full overflow-hidden rounded-full transition-[width] duration-500 ease-out ${
                  pipeline.status === 'failed'
                    ? 'bg-gradient-to-r from-red-500 to-red-600'
                    : 'bg-gradient-to-r from-emerald-500 to-emerald-600'
                }`}
                style={{ width: `${pipelineProgressPct}%` }}
              >
                {pipeline.running ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 animate-bulk-delete-sheen"
                  >
                    <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <p className="mt-1 text-[11px] tabular-nums text-slate-500">
            {serverSyncPhase
              ? 'Activity: sync in progress (no percent until the server finishes)'
              : `Progress: ${pipelineProgressPct}%`}
          </p>
        </div>
        {serverSyncPhase ? (
          <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50/90 px-2 py-1.5 text-[11px] leading-snug text-amber-950">
            Mailbox and message counts are hidden during a run so we don’t show numbers from the{' '}
            <strong className="font-medium">previous</strong> sync by mistake. They will appear here as
            soon as this run completes.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[11px] text-slate-500">
              Processed mailboxes: {pipeline.lastEmployees} · Relevant messages: {pipeline.lastMessages}
            </p>
            {pipeline.status === 'success' &&
            pipeline.lastMessages === 0 &&
            pipeline.lastEmployees > 0 ? (
              <p className="mt-1.5 text-[11px] leading-snug text-slate-600">
                Zero stored messages can still be a successful run: nothing in your tracking window passed Inbox AI,
                or you have not confirmed importing without Inbox AI. Check Settings → diagnostics and your tracking
                window above.
              </p>
            ) : null}
          </>
        )}
        {pipeline.status === 'failed' ? (
          <p className="mt-1 text-[11px] text-red-600">
            Failed: {pipeline.lastError || 'Unknown ingestion error'}
          </p>
        ) : null}
        {pipeline.status === 'success' && pipeline.finishedAt ? (
          <p className="mt-1 text-[11px] text-emerald-700">
            Completed at {absoluteTime(pipeline.finishedAt)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <AppShell
      role={me.role}
      companyName={me.company_name ?? null}
      userDisplayName={me.full_name?.trim() || me.email}
      title={pageTitle}
      subtitle={shellSubtitle}
      onSignOut={() => void ctxSignOut()}
    >
      {ingestWithoutAiPrompt && (
        <div
          className="fixed inset-0 z-[201] flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="ingest-without-ai-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-2xl">
            <h2 id="ingest-without-ai-title" className="text-lg font-semibold text-slate-900">
              Import without Inbox AI?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Gemini cannot run inbox classification until the items below are fixed. Otherwise you can still sync and we
              will store <strong className="font-medium">all</strong> mail in your tracking window (no AI filter).
            </p>
            {ingestWithoutAiPrompt.blockers.length > 0 ? (
              <ul className="mt-3 list-inside list-disc space-y-1.5 rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2.5 text-left text-xs text-amber-950">
                {ingestWithoutAiPrompt.blockers.map((line, i) => (
                  <li key={`${i}-${line.slice(0, 40)}`}>{line}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">
              Prefer AI filtering? Fix the list above, then click Start again without confirming unfiltered import.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setIngestWithoutAiPrompt(null)}
                disabled={ingestConfirmLoading}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmIngestWithoutAi()}
                disabled={ingestConfirmLoading}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {ingestConfirmLoading ? 'Saving…' : 'Confirm and start sync'}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkDeleteProgress && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-[2px]"
          role="alertdialog"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-900">
              {bulkDeleteProgress.stage === 'refreshing'
                ? 'Refreshing dashboard'
                : 'Deleting conversations'}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {bulkDeleteProgress.stage === 'refreshing'
                ? 'Updating tables…'
                : `${bulkDeleteProgress.done} of ${bulkDeleteProgress.total} removed`}
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-500">
              {bulkDeleteProgress.stage === 'refreshing'
                ? '100%'
                : `${bulkDeleteBarPct}%`}
            </p>
            <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/80">
              <div
                className={`relative h-full overflow-hidden rounded-full bg-gradient-to-r from-rose-500 to-rose-600 transition-[width] duration-500 ease-out ${
                  bulkDeleteProgress.stage === 'refreshing' ? 'animate-pulse' : ''
                }`}
                style={{ width: `${bulkDeleteBarPct}%` }}
              >
                {bulkDeleteProgress.stage === 'deleting' &&
                  bulkDeleteProgress.done < bulkDeleteProgress.total && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 animate-bulk-delete-sheen"
                    >
                      <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                    </div>
                  )}
              </div>
            </div>
            <p className="mt-4 text-center text-xs text-slate-500">
              Please keep this tab open until this finishes.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
        </div>
      )}

      {loading ? (
        <PageSkeleton />
      ) : (
        <>
          {myEmailTab === 'ceo' ? (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/60 bg-white p-3 shadow-card">
              <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                CEO inbox
              </span>
              <button
                type="button"
                onClick={() => setCeoInboxMode('live')}
                className={`rounded-full px-4 py-2 text-xs font-semibold shadow-sm transition-colors ${
                  ceoInboxMode === 'live'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200/90'
                }`}
              >
                Live Mails
              </button>
              <button
                type="button"
                onClick={() => {
                  setCeoInboxMode('historical');
                  if (!histEndDate || !histStartDate) {
                    const end = new Date();
                    const start = new Date();
                    start.setDate(start.getDate() - 30);
                    setHistEndDate(formatLocalYmd(end));
                    setHistStartDate(formatLocalYmd(start));
                  }
                }}
                className={`rounded-full px-4 py-2 text-xs font-semibold shadow-sm transition-colors ${
                  ceoInboxMode === 'historical'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200/90'
                }`}
              >
                Historical Search
              </button>
            </div>
          ) : null}

          {myEmailTab === 'ceo' && ceoInboxMode === 'live' ? (
            <LiveMailSyncBanner mailboxes={ownMailboxes} />
          ) : null}

          {myEmailTab === 'ceo' && ceoInboxMode === 'historical' ? (
            <section className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-5">
              <h2 className="text-lg font-bold text-slate-900">Historical Search</h2>
              {ownMailboxes.length > 0 ? (
                <p className="mt-2 text-[11px] text-slate-400">
                  Inbox: {ownMailboxes[0].name} · {ownMailboxes[0].email}
                </p>
              ) : null}
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Start date
                  <input
                    type="date"
                    value={histStartDate}
                    onChange={(e) => setHistStartDate(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  End date
                  <input
                    type="date"
                    value={histEndDate}
                    onChange={(e) => setHistEndDate(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </label>
                <div className="flex flex-wrap items-end gap-2">
                  <button
                    type="button"
                    onClick={() => void searchHistoricalFetch()}
                    disabled={historicalLoading}
                    className={`min-w-[12rem] rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-60 ${
                      historicalLoading ? 'motion-safe:animate-pulse motion-safe:ring-2 motion-safe:ring-white/40' : ''
                    }`}
                  >
                    {historicalLoading ? (
                      <span className="flex flex-col items-center gap-0.5 leading-tight">
                        <span>
                          {histLive.total > 0
                            ? `AI: ${histLive.currentIndex} / ${histLive.total}`
                            : histLive.gmailListDone
                              ? 'Starting AI…'
                              : 'Listing Gmail…'}
                        </span>
                        {histLive.total > 0 ? (
                          <span className="text-[11px] font-medium opacity-90">
                            {Math.max(0, histLive.total - histLive.currentIndex)} left · kept {histLive.relevantSoFar}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      'Fetch from Gmail'
                    )}
                  </button>
                  {historicalLoading ? (
                    <button
                      type="button"
                      onClick={() => historicalFetchAbortRef.current?.abort()}
                      className="rounded-xl border-2 border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-800 shadow-sm hover:bg-red-50"
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              </div>

              {historicalLoading ? (
                <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                  <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Live progress</p>
                      <p className="tabular-nums text-xs font-semibold text-brand-700">
                        {histElapsedSec}s elapsed
                        {histLive.total > 0 ? (
                          <span className="ml-2 text-slate-600">
                            ·{' '}
                            {histLive.phase === 'saving' ||
                            histLive.phase === 'recomputing' ||
                            histLive.phase === 'done'
                              ? '100% (AI pass done)'
                              : `${Math.min(100, Math.round((histLive.currentIndex / histLive.total) * 100))}% through AI`}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="relative mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-200/90 ring-1 ring-slate-300/40">
                      {histLive.total > 0 ? (
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-500 via-violet-500 to-brand-600 motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
                          style={{
                            width: `${
                              histLive.phase === 'saving' ||
                              histLive.phase === 'recomputing' ||
                              histLive.phase === 'done'
                                ? 100
                                : Math.min(100, (histLive.currentIndex / histLive.total) * 100)
                            }%`,
                          }}
                        />
                      ) : (
                        <div className="relative h-full w-full overflow-hidden rounded-full">
                          <div className="historical-progress-indeterminate-inner" aria-hidden />
                        </div>
                      )}
                    </div>
                    <ol className="mt-5 flex list-none flex-col gap-6 p-0">
                      <li className="flex items-start gap-4">
                        <div className="flex w-10 shrink-0 justify-center pt-0.5">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
                              histLive.gmailListDone
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : 'border-brand-400 bg-white text-brand-600 motion-safe:animate-pulse'
                            }`}
                            aria-hidden
                          >
                            {histLive.gmailListDone ? '✓' : '1'}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <p className="text-sm font-semibold text-slate-900">Gmail list</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-600">
                            {histLive.total > 0
                              ? `${histLive.listedTotal} message id(s) in range`
                              : 'Contacting Gmail and building the list…'}
                          </p>
                        </div>
                      </li>
                      <li className="flex items-start gap-4">
                        <div className="flex w-10 shrink-0 justify-center pt-0.5">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
                              histLive.phase === 'saving' ||
                              histLive.phase === 'recomputing' ||
                              histLive.phase === 'done'
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : histLive.total > 0
                                  ? 'border-brand-500 bg-brand-500 text-white motion-safe:animate-pulse'
                                  : 'border-slate-300 bg-white text-slate-400'
                            }`}
                            aria-hidden
                          >
                            {histLive.phase === 'saving' ||
                            histLive.phase === 'recomputing' ||
                            histLive.phase === 'done'
                              ? '✓'
                              : '2'}
                          </span>
                        </div>
                        <div
                          className={`min-w-0 flex-1 ${
                            histLive.total > 0 &&
                            histLive.phase !== 'saving' &&
                            histLive.phase !== 'recomputing' &&
                            histLive.phase !== 'done'
                              ? 'rounded-xl border border-brand-200/80 bg-brand-50/60 p-3 shadow-sm'
                              : 'pt-0.5'
                          }`}
                        >
                          <p className="text-sm font-semibold text-slate-900">Inbox AI (Gemini)</p>
                          <div className="mt-2 flex flex-wrap items-baseline gap-2 tabular-nums">
                            <span
                              key={histLive.currentIndex}
                              className="text-3xl font-bold text-brand-700 motion-safe:transition-transform motion-safe:duration-200"
                            >
                              {histLive.currentIndex}
                            </span>
                            <span className="text-sm font-medium text-slate-500">/</span>
                            <span className="text-xl font-semibold text-slate-700">{histLive.total || '—'}</span>
                            <span className="text-xs text-slate-500">processed</span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-slate-600">
                            {histLive.total > 0 ? (
                              <>
                                <strong className="font-semibold text-slate-800">
                                  {Math.max(0, histLive.total - histLive.currentIndex)}
                                </strong>{' '}
                                left · Kept:{' '}
                                <strong className="font-semibold text-emerald-700">{histLive.relevantSoFar}</strong>
                              </>
                            ) : (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="motion-safe:animate-pulse">Waiting for message count</span>
                              </span>
                            )}
                          </p>
                        </div>
                      </li>
                      <li className="flex items-start gap-4">
                        <div className="flex w-10 shrink-0 justify-center pt-0.5">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${
                              histLive.phase === 'recomputing' || histLive.phase === 'done'
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : histLive.phase === 'saving'
                                  ? 'border-brand-400 bg-white text-brand-600 motion-safe:animate-pulse'
                                  : 'border-slate-300 bg-white text-slate-400'
                            }`}
                            aria-hidden
                          >
                            {histLive.phase === 'recomputing' || histLive.phase === 'done' ? '✓' : '3'}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <p className="text-sm font-semibold text-slate-900">Save &amp; summarize</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-600">
                            {histLive.phase === 'saving'
                              ? 'Writing to database…'
                              : histLive.phase === 'recomputing'
                                ? 'Building threads…'
                                : histLive.phase === 'done'
                                  ? 'Done.'
                                  : 'Queued after AI…'}
                          </p>
                        </div>
                      </li>
                    </ol>
                    <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
                      Streamed from the server — numbers move as each message is handled. Keep this tab open.
                    </p>
                  </div>
                  <div className="flex max-h-80 min-h-[14rem] flex-col rounded-xl border border-emerald-100 bg-emerald-50/40">
                    <div className="border-b border-emerald-100/80 px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
                        AI kept (streams in)
                      </p>
                      <p className="text-[10px] text-emerald-800/80">
                        Each card is the exact Gmail message AI chose to track — same style tags as Live (client vs
                        your send, CC). Open in Gmail to verify the message.
                      </p>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                      {histLive.picks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                          <span className="flex items-center gap-1.5" aria-hidden>
                            <span className="historical-wait-dot" style={{ animationDelay: '0ms' }} />
                            <span className="historical-wait-dot" style={{ animationDelay: '150ms' }} />
                            <span className="historical-wait-dot" style={{ animationDelay: '300ms' }} />
                          </span>
                          <p className="text-xs text-slate-600">Waiting for the first relevant message…</p>
                        </div>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {histLive.picks.map((p, i) => (
                            <HistoricalStreamPickCard
                              key={`${p.messageId ?? `idx-${p.index}`}-${i}`}
                              p={p}
                              isLatest={i === histLive.picks.length - 1}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {historicalStats && !historicalLoading ? (
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold text-slate-900">{historicalStats.fetched_from_gmail}</p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Fetched from Gmail</p>
                  </div>
                  <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold text-emerald-700">{historicalStats.stored_relevant}</p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-600">AI: Relevant</p>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold text-slate-500">{historicalStats.skipped_irrelevant}</p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">AI: Skipped</p>
                  </div>
                  <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold text-brand-700">{historicalStats.conversations_created}</p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-brand-600">Conversations</p>
                  </div>
                </div>
              ) : null}

              {!historicalLoading && historicalSearched ? (
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <input
                    type="search"
                    placeholder="Filter results by subject, client…"
                    value={threadSearch}
                    onChange={(e) => setThreadSearch(e.target.value)}
                    className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:max-w-md"
                  />
                  {historicalRows.length > 0 ? (
                    <button
                      type="button"
                      disabled={histDeletingAll}
                      onClick={() => void deleteAllHistoricalResults()}
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-900 hover:bg-red-100 disabled:opacity-50"
                    >
                      {histDeletingAll ? 'Removing…' : `Delete all ${historicalRows.length} from tracker`}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {!historicalLoading && !historicalSearched ? (
                <p className="mt-8 text-center text-sm text-slate-500">
                  Choose a date range and click <strong className="font-medium text-slate-700">Fetch from Gmail</strong>.
                  The AI will pull all emails from that period, classify them, and show the important ones.
                </p>
              ) : !historicalLoading && historicalFilteredRows.length === 0 && historicalSearched ? (
                <p className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
                  {historicalStats && historicalStats.fetched_from_gmail === 0
                    ? 'No emails found in Gmail for that date range.'
                    : historicalStats && historicalStats.stored_relevant === 0
                      ? 'Emails were found but none passed AI relevance filtering. Try a different date range or check AI settings.'
                      : `No conversations found${threadSearch.trim() ? ' matching your filter' : ''}.`}
                </p>
              ) : !historicalLoading && historicalFilteredRows.length > 0 ? (
                <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                        <th className="px-3 py-3">Thread</th>
                        <th className="px-3 py-3">Status</th>
                        <th className="px-3 py-3">Priority</th>
                        <th className="min-w-[8rem] px-3 py-3">Client sent</th>
                        <th className="px-3 py-3">Gmail</th>
                        <th className="w-24 px-3 py-3 text-right">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {historicalFilteredRows.map((c) => {
                        return (
                          <tr
                            key={c.conversation_id}
                            className="cursor-pointer hover:bg-slate-50/90"
                            onClick={() => router.push(conversationReadPath(c.conversation_id, pathname))}
                          >
                            <ConversationSubjectCell c={c} />
                            <td className="px-3 py-3 align-top">
                              {statusBadge(c.follow_up_status)}
                            </td>
                            <td className="px-3 py-3 align-top">
                              <div className="flex items-center gap-1">
                                {priorityDot(c.priority)}
                                <span className="text-[10px] text-slate-500">{c.priority}</span>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-xs text-slate-500" title={c.last_client_msg_at ?? undefined}>
                              <RelWithAbsoluteDate iso={c.last_client_msg_at} />
                            </td>
                            <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                              <a
                                href={c.open_gmail_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-semibold text-brand-600 hover:underline"
                              >
                                Open
                              </a>
                            </td>
                            <td
                              className="px-3 py-3 text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                disabled={histRowDeletingId === c.conversation_id || histDeletingAll}
                                onClick={() => void deleteHistoricalRow(c.conversation_id)}
                                className="text-xs font-semibold text-red-700 hover:underline disabled:opacity-40"
                              >
                                {histRowDeletingId === c.conversation_id ? '…' : 'Delete'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : (
            <>
          {/* ── KPI strip — follow-up command center (scoped to tab) ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              {
                label: 'Need your reply',
                value: kpiNeedReplyCount,
                color: 'text-red-600',
              },
              {
                label: 'Waiting on them',
                value: kpiWaitingCount,
                color: 'text-slate-700',
              },
              {
                label: "CC'd (FYI)",
                value: ccScopedRows.length,
                color: 'text-sky-700',
                hint: 'Threads where you were only on Cc on the latest inbound',
              },
              {
                label: 'Missed SLA',
                value: scopedStats.missed,
                color: 'text-red-600',
              },
              {
                label: 'Resolved',
                value: scopedStats.done,
                color: 'text-emerald-600',
              },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card"
                title={'hint' in kpi && kpi.hint ? kpi.hint : undefined}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {kpi.label}
                </p>
                <p className={`mt-1 text-2xl font-bold ${kpi.color}`}>
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-col gap-8">
          {/* ── Follow-ups: tabs + compact list + drawer ── */}
          <section className="order-2 rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-5">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Follow-ups</h2>
              </div>
              <input
                type="search"
                placeholder="Search subject, client, person, thread id…"
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:max-w-xs"
                title="Filters the current tab only; combine with tabs (Need your reply, All threads, etc.)."
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Follow-up views">
              {(
                [
                  ['action', 'Need your reply'],
                  ['waiting', 'Waiting on them'],
                  ['cc', "CC'd"],
                  ['closed', 'Done'],
                  ['noise', 'Low / noise'],
                  ['all', 'All threads'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mailTab === id}
                  onClick={() => setMailTab(id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    mailTab === id
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200/90'
                  }`}
                >
                  {label}
                  {id === 'action' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({kpiNeedReplyCount})</span>
                  ) : null}
                  {id === 'waiting' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({kpiWaitingCount})</span>
                  ) : null}
                  {id === 'cc' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({ccScopedRows.length})</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              {scopedPersonOptions.length > 1 ? (
                <select
                  value={filterMailbox}
                  onChange={(e) => setFilterMailbox(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                >
                  <option value="">All people in this view</option>
                  {scopedPersonOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {mailTab === 'all' ? (
                <>
                  <select
                    value={allTabStatus}
                    onChange={(e) => setAllTabStatus(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">All statuses</option>
                    <option value="MISSED">Missed</option>
                    <option value="PENDING">Pending</option>
                    <option value="DONE">Done</option>
                  </select>
                  <select
                    value={allTabPriority}
                    onChange={(e) => setAllTabPriority(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">All priorities</option>
                    <option value="HIGH">High</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="LOW">Low</option>
                  </select>
                </>
              ) : null}
            </div>

            {searchFilteredTabRows.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-50 pt-4">
                <button
                  type="button"
                  disabled={bulkSelected.size === 0 || bulkBusy}
                  onClick={() => void deleteSelectedInTab()}
                  className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-900 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {bulkPrimaryActionLabel ?? `Delete selected (${bulkSelected.size})`}
                </button>
                <button
                  type="button"
                  disabled={searchFilteredTabRows.length === 0 || bulkBusy}
                  onClick={() => toggleSelectAllInTab()}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  {allTabRowsSelected ? 'Clear selection' : `Select all (${searchFilteredTabRows.length})`}
                </button>
                <span className="text-xs text-slate-500">Portal only — Gmail unchanged.</span>
              </div>
            ) : null}

            {scopedConversations.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center text-sm text-slate-600">
                {scopeMailboxIds.size === 0
                  ? 'No mailboxes in this view yet.'
                  : mailboxesForInboxShortcuts.some((m) => m.gmail_connected)
                    ? 'No conversations yet — sync will create threads from relevant mail.'
                    : 'Connect Gmail on a mailbox card below to start.'}
              </div>
            ) : searchFilteredTabRows.length === 0 ? (
              <p className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                No threads in this tab
                {threadSearch.trim() ? ' matching your search' : ''}.
                {threadSearch.trim() && tabSourceRows.length > 0 ? (
                  <>
                    {' '}
                    <span className="font-medium text-slate-800">
                      {tabSourceRows.length} thread{tabSourceRows.length === 1 ? '' : 's'} match this tab but not the search box — clear search to see them.
                    </span>
                  </>
                ) : null}{' '}
                Try another tab
                {mailTab === 'action'
                  ? ` — older “need reply” threads (last client message over ${STALE_NEED_REPLY_DAYS} days ago) appear under All threads.`
                  : ''}
                {mailTab === 'action' && hideLowPriority
                  ? ' LOW priority appears under Low / noise.'
                  : mailTab !== 'action' && hideLowPriority
                    ? ' LOW priority may be under Low / noise.'
                    : ''}
              </p>
            ) : (
              <>
                <div className="mt-4 overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                        <th className="w-10 px-3 py-3">
                          <input
                            type="checkbox"
                            checked={allTabRowsSelected}
                            onChange={() => toggleSelectAllInTab()}
                            aria-label="Select all in this tab"
                            disabled={bulkBusy}
                            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                          />
                        </th>
                        {scopedPersonOptions.length > 1 ? (
                          <th className="px-3 py-3">Person</th>
                        ) : null}
                        <th className="px-3 py-3">Thread</th>
                        <th className="px-3 py-3">SLA</th>
                        <th className="min-w-[8rem] px-3 py-3">Activity</th>
                        <th className="px-3 py-3">Gmail</th>
                        <th className="min-w-[5rem] px-3 py-3 text-right">Resolve</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {pagedTabRows.map((c) => {
                        const sla = slaChipLabel(c);
                        return (
                          <tr
                            key={c.conversation_id}
                            className="cursor-pointer hover:bg-slate-50/90"
                            onClick={() => router.push(conversationReadPath(c.conversation_id, pathname))}
                          >
                            <td className="px-3 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={bulkSelected.has(c.conversation_id)}
                                onChange={() => {
                                  setBulkSelected((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(c.conversation_id)) next.delete(c.conversation_id);
                                    else next.add(c.conversation_id);
                                    return next;
                                  });
                                }}
                                disabled={bulkBusy}
                                aria-label={`Select ${conversationDisplayTitle(c).slice(0, 60)}`}
                                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                              />
                            </td>
                            {scopedPersonOptions.length > 1 ? (
                              <td className="whitespace-nowrap px-3 py-3 text-xs font-medium text-slate-800">
                                {c.employee_name}
                              </td>
                            ) : null}
                            <ConversationSubjectCell c={c} />
                            <td className="px-3 py-3 align-top">
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${sla.className}`}
                              >
                                {sla.text}
                              </span>
                              <div className="mt-1 flex items-center gap-1">
                                {priorityDot(c.priority)}
                                <span className="text-[10px] text-slate-500">{c.priority}</span>
                              </div>
                            </td>
                            <td
                              className="px-3 py-3 text-xs text-slate-500"
                              title={c.last_employee_reply_at ?? c.last_client_msg_at ?? undefined}
                            >
                              <RelWithAbsoluteDate
                                iso={c.last_employee_reply_at ?? c.last_client_msg_at}
                              />
                            </td>
                            <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                              <a
                                href={c.open_gmail_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-semibold text-brand-600 hover:underline"
                              >
                                Open
                              </a>
                            </td>
                            <td className="px-3 py-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                              {c.follow_up_status !== 'DONE' ? (
                                <button
                                  type="button"
                                  disabled={resolvingId === c.conversation_id}
                                  onClick={() => void resolveConversation(c.conversation_id)}
                                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                                  title="Mark this thread resolved if you already replied or no follow-up is needed"
                                >
                                  {resolvingId === c.conversation_id ? '…' : 'Resolve'}
                                </button>
                              ) : (
                                <span className="text-[11px] text-slate-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    Showing {pagedTabRows.length} of {searchFilteredTabRows.length}
                    {threadSearch.trim() ? ' matching search' : ''} in this tab
                  </span>
                  {hasMoreTabRows ? (
                    <button
                      type="button"
                      onClick={() => setMailListPage((p) => p + 1)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                    >
                      Load more ({MAIL_PAGE_SIZE} rows)
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </section>

          {/* ── Mailboxes: CEO / Manager / Team are separate views (sidebar hash), not one scroll ── */}
          <section className="order-1">
            {myEmailTab === 'ceo' ? (
              <>
                <div className="mb-3">
                  <h2 className="text-lg font-bold text-slate-900">Your inbox (CEO)</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Only your CEO login mailbox appears here.
                  </p>
                </div>

                {mailboxes.length === 0 && (
                  <div className="mb-4 rounded-2xl border border-brand-200/80 bg-gradient-to-br from-indigo-50/90 to-white p-6 shadow-card">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                      Your inbox (CEO)
                    </p>
                    <h3 className="mt-1 text-base font-bold text-slate-900">
                      Connect your own Gmail
                    </h3>
                    <button
                      type="button"
                      onClick={() => void connectMyInbox()}
                      disabled={adding}
                      className="mt-4 w-full rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:opacity-95 disabled:opacity-60 sm:w-auto"
                    >
                      {adding ? 'Opening…' : 'Connect my Gmail'}
                    </button>
                  </div>
                )}

                {mailboxes.length > 0 ? (
                  <div className="mt-2">
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {ownMailboxes.map((mb) => (
                      <div key={mb.id} className="space-y-2">
                        <TrackedMailboxCard
                          mb={mb}
                          ceoEmailNorm={ceoEmailNorm}
                          onConnectGmail={() => void connectGmail(mb.id)}
                          onRemove={() => void removeMailbox(mb.id)}
                          onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                          removing={deletingId === mb.id}
                          togglePauseLoading={togglePauseLoadingId === mb.id}
                        />
                      </div>
                      ))}
                    </div>
                    {ownMailboxes.length === 0 ? (
                      <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-4 text-sm text-slate-600">
                        <p>
                          Your work inbox isn&apos;t listed yet. Use{' '}
                          <strong className="font-medium text-slate-800">Connect my Gmail</strong> so
                          the row matches your CEO email.
                        </p>
                        <button
                          type="button"
                          onClick={() => void connectMyInbox()}
                          disabled={adding}
                          className="mt-3 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-60"
                        >
                          {adding ? 'Opening…' : 'Connect my Gmail'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {myEmailTab === 'manager' ? (
              <div
                id="manager-mailboxes"
                className="scroll-mt-24 rounded-2xl border border-slate-100 bg-slate-50/40 px-4 py-5 sm:px-6"
              >
                <h2 className="text-lg font-bold text-slate-900">Manager mailboxes</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Department heads only.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {managerMailboxes.map((mb) => (
                    <div key={mb.id} className="space-y-2">
                      <TrackedMailboxCard
                        mb={mb}
                        ceoEmailNorm={ceoEmailNorm}
                        onConnectGmail={() => void connectGmail(mb.id)}
                        onRemove={() => void removeMailbox(mb.id)}
                        onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                        removing={deletingId === mb.id}
                        togglePauseLoading={togglePauseLoadingId === mb.id}
                      />
                    </div>
                  ))}
                </div>
                {managerMailboxes.length === 0 ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    No manager inboxes yet.
                  </p>
                ) : null}
              </div>
            ) : null}

            {myEmailTab === 'team' ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-bold text-slate-900">Team mailboxes</h2>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm((v) => {
                        const open = !v;
                        if (open) {
                          setAddName('');
                          setAddEmail('');
                        }
                        return open;
                      });
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                  >
                    {showAddForm ? 'Cancel' : '+ Add another mailbox'}
                  </button>
                </div>

                {showAddForm && (
                  <div className="mb-4 rounded-2xl border border-slate-200/60 bg-white p-5 shadow-card">
                    <p className="mb-3 text-sm font-semibold text-slate-700">
                      Add someone else&apos;s mailbox (IC, shared inbox, etc.)
                    </p>
                    <p className="mb-3 text-xs text-slate-500">
                      Enter <strong>their</strong> full name and work email — not yours.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="Full name"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                      <input
                        type="email"
                        placeholder="Email address"
                        value={addEmail}
                        onChange={(e) => setAddEmail(e.target.value)}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void addMailbox()}
                        disabled={adding || !addName.trim() || !addEmail.trim()}
                        className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-brand-600/20 hover:opacity-95 disabled:opacity-50"
                      >
                        {adding ? 'Adding...' : 'Add mailbox'}
                      </button>
                    </div>
                  </div>
                )}

                {mailboxes.length === 0 && showAddForm ? (
                  <div className="mb-4 rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center shadow-card">
                    <p className="text-sm text-slate-600">
                      Fill in the form above to add a tracked mailbox, or cancel and add people from{' '}
                      <strong>Employees</strong> first.
                    </p>
                  </div>
                ) : null}

                <div
                  id="team-mailboxes-ceo"
                  className="scroll-mt-24 rounded-2xl border border-slate-100 bg-white px-4 py-5 shadow-sm sm:px-6"
                >
                  <p className="text-xs text-slate-600">
                    Individual contributors and other org mail — <strong>not</strong> your CEO login and{' '}
                    <strong>not</strong> department manager rows (those are under Manager mail).
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {teamMailboxesOnly.map((mb) => (
                      <div key={mb.id} className="space-y-2">
                        <TrackedMailboxCard
                          mb={mb}
                          ceoEmailNorm={ceoEmailNorm}
                          onConnectGmail={() => void connectGmail(mb.id)}
                          onRemove={() => void removeMailbox(mb.id)}
                          onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                          removing={deletingId === mb.id}
                          togglePauseLoading={togglePauseLoadingId === mb.id}
                        />
                      </div>
                    ))}
                  </div>
                  {teamMailboxesOnly.length === 0 ? (
                    <p className="mt-3 text-center text-sm text-slate-500">
                      No team mailboxes yet. Add people on <strong>Employees</strong> or use{' '}
                      <strong>+ Add another mailbox</strong> above.
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
          </div>
            </>
          )}

        </>
      )}
    </AppShell>
  );
}

export default function MyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <PageSkeleton />
        </div>
      }
    >
      <MyEmailPageInner />
    </Suspense>
  );
}
