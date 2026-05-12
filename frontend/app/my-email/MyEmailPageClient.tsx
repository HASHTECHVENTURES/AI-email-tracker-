'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
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
import { PortalPageLoader } from '@/components/PortalPageLoader';
import { TrackedMailboxCard } from '@/components/my-email/TrackedMailboxCard';
import { conversationReadPath } from '@/lib/conversation-read';
import { openGmailOAuthWindow, subscribeGmailOAuthComplete } from '@/lib/gmail-oauth';
import { isDepartmentManagerRole } from '@/lib/roles';

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
  last_gmail_sync_at?: string | null;
  last_ai_analysis_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
  ai_enabled?: boolean;
  /** True when this mailbox email has an app portal login. */
  has_portal_login?: boolean;
  /** Same email on another dept roster; mail sync uses the primary row (`roster_duplicate` false). */
  roster_duplicate?: boolean;
};

/** Prefer API boolean; fall back to status string (some paths only set `gmail_status`). */
function isMailboxGmailConnected(m: Pick<Mailbox, 'gmail_connected' | 'gmail_status'>): boolean {
  if (m.gmail_connected === true) return true;
  return m.gmail_status === 'CONNECTED';
}

/** One UI row per inbox email when duplicate `employees` roster rows exist (e.g. secondary team listing). */
function dedupeMailboxesByEmailPreferPrimary(mailboxes: Mailbox[]): Mailbox[] {
  const byEmail = new Map<string, Mailbox[]>();
  for (const mb of mailboxes) {
    const e = mb.email.trim().toLowerCase();
    if (!e) continue;
    const arr = byEmail.get(e) ?? [];
    arr.push(mb);
    byEmail.set(e, arr);
  }
  const picked: Mailbox[] = [];
  for (const arr of byEmail.values()) {
    if (arr.length === 1) {
      picked.push(arr[0]);
      continue;
    }
    const sorted = [...arr].sort((a, b) => {
      const dupA = a.roster_duplicate === true ? 1 : 0;
      const dupB = b.roster_duplicate === true ? 1 : 0;
      if (dupA !== dupB) return dupA - dupB;
      const gA = isMailboxGmailConnected(a) ? 0 : 1;
      const gB = isMailboxGmailConnected(b) ? 0 : 1;
      if (gA !== gB) return gA - gB;
      return a.id.localeCompare(b.id);
    });
    picked.push(sorted[0]);
  }
  picked.sort((a, b) => a.name.localeCompare(b.name));
  return picked;
}

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

type MailTab = 'action' | 'waiting' | 'cc' | 'closed' | 'noise' | 'all' | 'skipped';

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
      'The API your browser calls does not see an AI key yet. Add GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) on the **same Railway service that runs this backend**, then click **Redeploy** (variables apply to new deploys). Check `https://YOUR-BACKEND-HOST/health` — `gemini_configured` must be `true`.',
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
  nextIngestionAt?: string | null;
  secondsUntilNextIngestion?: number | null;
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

function formatLocalHm(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Defaults to “now” when the mailbox has no tracking start yet. */
function isoToLiveTrackingDateTime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso?.trim()) {
    const d = new Date();
    return { date: formatLocalYmd(d), time: formatLocalHm(d) };
  }
  const d = new Date(iso.trim());
  if (Number.isNaN(d.getTime())) {
    const n = new Date();
    return { date: formatLocalYmd(n), time: formatLocalHm(n) };
  }
  return { date: formatLocalYmd(d), time: formatLocalHm(d) };
}

function liveTrackingDateTimeToIso(dateYmd: string, timeHm: string): string | null {
  const dStr = dateYmd.trim();
  const tStr = timeHm.trim();
  if (!dStr || !tStr) return null;
  const ymd = dStr.split('-').map((p) => Number(p));
  if (ymd.length !== 3 || ymd.some((n) => !Number.isFinite(n))) return null;
  const [y, mo, da] = ymd;
  const timeParts = tStr.split(':');
  const hh = Number(timeParts[0]);
  const mi = Number(timeParts[1] ?? '0');
  const ss = timeParts[2] != null ? Number(timeParts[2]) : 0;
  if (![hh, mi, ss].every((n) => Number.isFinite(n))) return null;
  const local = new Date(y, mo - 1, da, hh, mi, ss, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

/** One-line preview of the chosen tracking instant in the user’s locale (reduces date-format confusion). */
function trackingWindowPreviewLine(dateYmd: string, timeHm: string): string | null {
  const iso = liveTrackingDateTimeToIso(dateYmd, timeHm);
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Live progress for POST /self-tracking/historical-fetch-stream (same engine as Historical Search). */
type HistoricalBackfillUi = {
  employeeId: string;
  mailboxEmail: string;
  mailboxIndex?: number;
  mailboxTotal?: number;
  phase: string;
  totalIds: number;
  messageIndex: number;
  messageTotal: number;
  lastSubject: string;
  lastFrom: string;
  lastRelevant?: boolean;
  lastReason?: string | null;
  savingCount?: number;
  recomputingThreads?: number;
  /** CEO portal: running tallies from each Inbox AI decision (messages are saved in one batch afterward). */
  runningTracked?: number;
  runningSkippedAi?: number;
  runningAlreadySynced?: number;
  runningOutsideRange?: number;
  runningCcOnly?: number;
  complete?: {
    fetched: number;
    stored: number;
    skipped: number;
    conversationsCreated: number;
  };
  error?: string;
};

function HistoricalBackfillProgressBlock({
  ui,
  windowLine,
  ceoPortalDetail,
}: {
  ui: HistoricalBackfillUi | null;
  windowLine?: string | null;
  /** CEO · My Email (inbox tab): richer progress, running AI counts, and post-run spot-check hints. */
  ceoPortalDetail?: boolean;
}): ReactNode {
  if (!ui) return null;
  const multi =
    ui.mailboxTotal != null && ui.mailboxTotal > 1 && ui.mailboxIndex != null
      ? `Mailbox ${ui.mailboxIndex} of ${ui.mailboxTotal} · ${ui.mailboxEmail}`
      : ui.mailboxEmail;
  const capNote =
    ui.totalIds >= 500 ? (
      <p className="mt-2 text-[10px] leading-snug text-amber-800">
        Same cap as Historical Search: up to <strong className="font-medium">500</strong> messages analyzed
        in this pass. Narrow the window or run again later if you need more depth.
      </p>
    ) : null;
  const detail = Boolean(ceoPortalDetail);
  const totalForBar = Math.max(1, ui.messageTotal || ui.totalIds || 1);
  const barPct =
    ui.phase === 'complete' || ui.phase === 'error'
      ? 100
      : Math.min(100, Math.round((100 * (ui.messageIndex || 0)) / totalForBar));
  const rt = ui.runningTracked ?? 0;
  const rsa = ui.runningSkippedAi ?? 0;
  const ral = ui.runningAlreadySynced ?? 0;
  const rout = ui.runningOutsideRange ?? 0;
  const rcc = ui.runningCcOnly ?? 0;
  if (ui.phase === 'error') {
    return (
      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
        <p className="font-semibold">Analysis stopped</p>
        <p className="mt-1">{ui.error ?? 'Something went wrong.'}</p>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-3 text-left text-xs text-slate-700">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Historical-style backfill → now
      </p>
      {windowLine ? (
        <p className="text-[11px] text-slate-600">
          Window: <span className="font-medium text-slate-900">{windowLine}</span> through{' '}
          <span className="font-medium text-slate-900">now</span>
        </p>
      ) : null}
      <p className="text-[11px] text-slate-600">{multi}</p>
      {detail ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            <span>AI pass progress</span>
            <span className="tabular-nums text-slate-700">{barPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/90 ring-1 ring-slate-300/60">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                ui.phase === 'saving' || ui.phase === 'recomputing'
                  ? 'animate-pulse bg-gradient-to-r from-violet-500 to-indigo-600'
                  : 'bg-gradient-to-r from-brand-600 to-violet-600'
              }`}
              style={{ width: `${barPct}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">Will track</span>{' '}
              <span className="tabular-nums font-semibold text-emerald-800">{rt}</span>
            </p>
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">Skipped (AI)</span>{' '}
              <span className="tabular-nums font-semibold text-slate-800">{rsa}</span>
            </p>
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">Already synced</span>{' '}
              <span className="tabular-nums font-semibold text-slate-700">{ral}</span>
            </p>
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">Outside window</span>{' '}
              <span className="tabular-nums font-semibold text-slate-700">{rout}</span>
            </p>
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">CC-only (FYI)</span>{' '}
              <span className="tabular-nums font-semibold text-sky-800">{rcc}</span>
            </p>
            <p className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">Processed</span>{' '}
              <span className="tabular-nums font-semibold text-slate-900">
                {rt + rsa + ral + rout}
              </span>
              {ui.messageTotal > 0 ? (
                <span className="text-slate-500">
                  {' '}
                  / {ui.messageTotal} listed
                </span>
              ) : null}
            </p>
          </div>
          {ui.phase === 'saving' || ui.phase === 'recomputing' ? (
            <p className="text-[10px] leading-snug text-violet-900/90">
              Stat cards and tab counts above refresh while messages are written and threads are recomputed — they
              may lag the AI counters by a few seconds.
            </p>
          ) : ui.phase !== 'complete' ? (
            <p className="text-[10px] leading-snug text-slate-500">
              Each message is scored by Inbox AI before anything is saved; category chips fill in after the batch
              save.
            </p>
          ) : null}
        </div>
      ) : null}
      {ui.phase === 'connecting' ? (
        <p className="text-sm text-slate-600">Connecting to Gmail and listing messages in your window…</p>
      ) : null}
      {ui.phase === 'listed' ? (
        <p className="text-sm text-slate-800">
          Listed <strong className="tabular-nums">{ui.totalIds}</strong> message
          {ui.totalIds === 1 ? '' : 's'} from Gmail — running Inbox AI on each.
        </p>
      ) : null}
      {(ui.phase === 'message' || ui.phase === 'ai_decision') && ui.messageTotal > 0 ? (
        <p className="text-sm text-slate-800">
          <span className="tabular-nums font-semibold text-slate-900">
            {ui.messageIndex}/{ui.messageTotal}
          </span>
          {ui.lastSubject ? (
            <>
              {' '}
              <span className="text-slate-600">—</span> {clipStr(ui.lastSubject, 72)}
            </>
          ) : null}
        </p>
      ) : null}
      {ui.phase === 'ai_decision' && ui.lastSubject ? (
        <p className="text-[11px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-800">{clipStr(ui.lastFrom, 48)}</span>
          {typeof ui.lastRelevant === 'boolean' ? (
            <>
              {' · '}
              <span className={ui.lastRelevant ? 'text-emerald-700' : 'text-slate-500'}>
                {ui.lastRelevant ? 'Will track in portal' : 'Skipped'}
              </span>
              {ui.lastReason ? (
                <>
                  {' — '}
                  <span className="italic">{clipStr(ui.lastReason, 120)}</span>
                </>
              ) : null}
            </>
          ) : null}
        </p>
      ) : null}
      {ui.phase === 'saving' ? (
        <p className="text-sm text-slate-800">
          Saving <strong className="tabular-nums">{ui.savingCount ?? 0}</strong> relevant message
          {(ui.savingCount ?? 0) === 1 ? '' : 's'}…
        </p>
      ) : null}
      {ui.phase === 'recomputing' ? (
        <p className="text-sm text-slate-800">
          Building follow-up threads for{' '}
          <strong className="tabular-nums">{ui.recomputingThreads ?? 0}</strong> conversation
          {(ui.recomputingThreads ?? 0) === 1 ? '' : 's'}…
        </p>
      ) : null}
      {ui.phase === 'complete' && ui.complete ? (
        <>
          <p className="text-[11px] leading-relaxed text-slate-700">
            Backfill complete:{' '}
            <strong className="tabular-nums">{ui.complete.fetched}</strong> fetched,{' '}
            <strong className="tabular-nums">{ui.complete.stored}</strong> stored,{' '}
            <strong className="tabular-nums">{ui.complete.skipped}</strong> skipped by AI,{' '}
            <strong className="tabular-nums">{ui.complete.conversationsCreated}</strong> threads updated.
          </p>
          {detail ? (
            <div className="rounded-md border border-emerald-200/80 bg-emerald-50/60 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-950">
              <p className="font-semibold text-emerald-900">Check categories</p>
              <p className="mt-1">
                <strong className="tabular-nums">{ui.complete.stored}</strong> relevant messages were saved; threads
                were split into <strong className="tabular-nums">{ui.complete.conversationsCreated}</strong> created or
                updated rows. Open <strong className="font-medium">Need reply</strong>,{' '}
                <strong className="font-medium">Waiting on them</strong>, <strong className="font-medium">CC&apos;d</strong>,{' '}
                <strong className="font-medium">Done</strong>, and <strong className="font-medium">Low priority</strong>{' '}
                to confirm everything landed where you expect. Compare the stat row for{' '}
                <strong className="font-medium">Missed SLA</strong> and <strong className="font-medium">Resolved</strong>{' '}
                as well. AI-only skips are under <strong className="font-medium">Skipped</strong> ({ui.complete.skipped}{' '}
                this run).
              </p>
              {ui.complete.stored > 0 && rt > 0 && ui.complete.stored !== rt ? (
                <p className="mt-1.5 text-[10px] text-emerald-900/85">
                  Note: “Will track” during the pass ({rt}) can differ slightly from “stored” ({ui.complete.stored})
                  if the server merged duplicates or trimmed the batch.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {capNote}
    </div>
  );
}

/** Map a stored ISO window boundary to `input[type=date]` value in local time. */
type AiSkippedMailItem = {
  employee_id: string;
  provider_message_id: string;
  skipped_at: string;
  skip_kind: string;
  skip_reason: string | null;
  skip_reason_code?: string | null;
  classification_status?: string | null;
  ai_confidence_score?: number | null;
  subject: string | null;
  from_email: string | null;
  sent_at: string | null;
  provider_thread_id: string | null;
};

function skipKindShortLabel(kind: string): string {
  if (kind === 'ai_irrelevant') return 'Inbox AI';
  if (kind === 'before_tracking') return 'Before tracking';
  if (kind === 'legacy') return 'Older skip';
  return kind;
}

function skipReasonBadgeLabel(row: AiSkippedMailItem): string {
  const code = row.skip_reason_code ?? '';
  const labels: Record<string, string> = {
    low_confidence: 'Low confidence',
    missing_thread_context: 'Missing thread context',
    unsupported_format: 'Unsupported format',
    attachment_only: 'Attachment only',
    empty_body: 'Empty body',
    parsing_failed: 'Parsing failed',
  };
  if (code && labels[code]) {
    if (code === 'unsupported_format') {
      const r = (row.skip_reason ?? '').toLowerCase();
      const looksLikeRealFormatIssue =
        /\bunsupported\b|\bformat\b|mime|content-type|\.ics\b|\bics\b|\bcalendar\b|\binvite\b|text\/calendar/.test(
          r,
        );
      if (!looksLikeRealFormatIssue) return labels.low_confidence;
    }
    return labels[code];
  }
  const reason = (row.skip_reason ?? '').toLowerCase();
  if (reason.includes('attachment')) return labels.attachment_only;
  if (reason.includes('empty')) return labels.empty_body;
  if (reason.includes('parse') || reason.includes('failed')) return labels.parsing_failed;
  if (reason.includes('context') || reason.includes('thread')) return labels.missing_thread_context;
  // Avoid substring "format" inside "information", "transformation", etc. (mirrors backend skipReasonCodeForMessage).
  if (/\bunsupported\b|\bformat\b/i.test(reason)) return labels.unsupported_format;
  return labels.low_confidence;
}

function confidenceLabel(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'Confidence unknown';
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}% confidence`;
}

function clipStr(s: string | null | undefined, max: number): string {
  const t = (s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Default mail client reply to sender (Re: subject). */
function mailtoReplyHref(toRaw: string | null | undefined, subjectRaw: string | null | undefined): string | null {
  const to = (toRaw ?? '').trim();
  if (!to) return null;
  const sub = subjectRaw?.trim() ? `Re: ${subjectRaw.trim()}` : 'Re: (no subject)';
  return `mailto:${to}?subject=${encodeURIComponent(sub)}`;
}

const AI_SKIPPED_PAGE = 25;

/** Inbox AI / tracking skips — rendered inside Follow-ups → Skipped tab (same table chrome as other tabs). */
function SkippedMailsTabTable({
  mailboxes,
  rows,
  aiSkippedMailboxId,
  onMailboxChange,
  onRefresh,
  aiSkippedLoading,
  aiSkippedTotal,
  aiSkippedOffset,
  setAiSkippedOffset,
  onClearSkip,
  aiSkippedClearingId,
  unfilteredPageCount,
  selectedIds,
  onToggleSelect,
  onSelectAllVisible,
  onBulkClearSkip,
  skippedBulkClearing,
}: {
  mailboxes: Mailbox[];
  rows: AiSkippedMailItem[];
  /** Rows on this API page before client search filter (for empty-state copy). */
  unfilteredPageCount: number;
  aiSkippedMailboxId: string;
  onMailboxChange: (id: string) => void;
  onRefresh: () => void;
  aiSkippedLoading: boolean;
  aiSkippedTotal: number;
  aiSkippedOffset: number;
  setAiSkippedOffset: Dispatch<SetStateAction<number>>;
  onClearSkip: (providerMessageId: string) => void;
  aiSkippedClearingId: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (providerMessageId: string) => void;
  onSelectAllVisible: () => void;
  onBulkClearSkip: () => void;
  skippedBulkClearing: boolean;
}) {
  const selectAllRef = useRef<HTMLInputElement>(null);
  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.provider_message_id));
  const someVisibleSelected = rows.some((r) => selectedIds.has(r.provider_message_id));
  const selectedOnPageCount = rows.filter((r) => selectedIds.has(r.provider_message_id)).length;

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    el.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {mailboxes.length > 1 ? (
          <label className="flex min-w-[12rem] flex-col gap-1 text-xs font-medium text-slate-600">
            Mailbox
            <select
              value={aiSkippedMailboxId}
              onChange={(e) => onMailboxChange(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {mailboxes.map((mb) => (
                <option key={mb.id} value={mb.id}>
                  {mb.name} · {mb.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={aiSkippedLoading}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {aiSkippedLoading ? 'Loading…' : 'Refresh now'}
            </button>
            <span className="text-[11px] text-slate-500">
              {aiSkippedTotal} total skip{aiSkippedTotal === 1 ? '' : 's'} recorded
            </span>
          </div>
          <p className="text-[10px] text-slate-400 sm:text-right">
            Updates automatically every 20s while this tab is open (and when you return to the window).
          </p>
        </div>
      </div>
      <p className="rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 text-sm text-slate-600">
        These conversations could not be confidently categorized by AI.
      </p>
      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={selectedIds.size === 0 || skippedBulkClearing}
            onClick={onBulkClearSkip}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 shadow-sm hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {skippedBulkClearing
              ? 'Analyzing…'
              : `Reanalyze selected (${selectedIds.size})`}
          </button>
          <button
            type="button"
            disabled={rows.length === 0 || skippedBulkClearing}
            onClick={onSelectAllVisible}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {allVisibleSelected && selectedOnPageCount > 0
              ? 'Clear selection'
              : `Select all visible (${rows.length})`}
          </button>
          <span className="text-[11px] text-slate-500">Ledger only — Gmail unchanged.</span>
        </div>
      ) : null}
      {rows.length === 0 && !aiSkippedLoading ? (
        <p className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3 text-sm text-slate-600">
          {aiSkippedTotal === 0
            ? 'No skipped conversations in this tracking window.'
            : unfilteredPageCount > 0
              ? 'No matches for your search in the rows on this page — clear search or use Previous / Next.'
              : 'Nothing on this results page — use Previous / Next.'}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-100 text-left text-xs">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-10 px-2 py-2" scope="col">
                  <span className="sr-only">Select</span>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected && rows.length > 0}
                    onChange={onSelectAllVisible}
                    disabled={skippedBulkClearing || rows.length === 0}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
                    aria-label="Select all visible skipped messages"
                  />
                </th>
                <th className="px-3 py-2">Analyzed</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">From / subject</th>
                <th className="px-3 py-2">Confidence</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {rows.map((row) => {
                const gmailUrl =
                  row.provider_thread_id && row.provider_thread_id.length > 0
                    ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(row.provider_thread_id)}`
                    : null;
                return (
                  <tr key={`${row.employee_id}:${row.provider_message_id}`} className="align-top">
                    <td className="px-2 py-2.5 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.provider_message_id)}
                        onChange={() => onToggleSelect(row.provider_message_id)}
                        disabled={
                          skippedBulkClearing ||
                          aiSkippedClearingId === row.provider_message_id
                        }
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
                        aria-label={`Select skipped message ${row.subject ?? row.provider_message_id}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <RelWithAbsoluteDate iso={row.skipped_at} />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-100">
                        {skipReasonBadgeLabel(row)}
                      </span>
                      <p className="mt-1 max-w-[12rem] text-[10px] leading-snug text-slate-500">
                        {clipStr(row.skip_reason, 110) || skipKindShortLabel(row.skip_kind)}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="max-w-[14rem] font-medium text-slate-900 sm:max-w-xs">
                        {clipStr(row.subject, 72) || '(No subject)'}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {clipStr(row.from_email, 48) || '—'}
                        {row.sent_at ? (
                          <span className="ml-1 tabular-nums text-slate-400">
                            · {absoluteTime(row.sent_at)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {confidenceLabel(row.ai_confidence_score)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex flex-col items-end gap-2">
                        <button
                          type="button"
                          disabled={aiSkippedClearingId === row.provider_message_id}
                          onClick={() => onClearSkip(row.provider_message_id)}
                          className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {aiSkippedClearingId === row.provider_message_id ? 'Analyzing…' : 'Reanalyze'}
                        </button>
                        {gmailUrl ? (
                          <a
                            href={gmailUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-slate-600 hover:underline"
                          >
                            Open in Gmail
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {aiSkippedTotal > AI_SKIPPED_PAGE ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            disabled={aiSkippedOffset <= 0 || aiSkippedLoading}
            onClick={() => setAiSkippedOffset((o) => Math.max(0, o - AI_SKIPPED_PAGE))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={aiSkippedOffset + AI_SKIPPED_PAGE >= aiSkippedTotal || aiSkippedLoading}
            onClick={() => setAiSkippedOffset((o) => o + AI_SKIPPED_PAGE)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Next
          </button>
          <span className="text-slate-500">
            Showing {aiSkippedOffset + 1}–{Math.min(aiSkippedOffset + AI_SKIPPED_PAGE, aiSkippedTotal)} of{' '}
            {aiSkippedTotal}
          </span>
        </div>
      ) : null}
    </div>
  );
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

/** Latest Gmail sync time among mailboxes. Tracking start remains a separate product window. */
function pickLatestMailboxSyncIso(mailboxes: Mailbox[]): string | null {
  let best = -1;
  let iso: string | null = null;
  for (const m of mailboxes) {
    const raw = m.last_gmail_sync_at ?? m.last_synced_at;
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

/** Next crawl time from ISO (UTC from API), shown in the user’s local timezone. */
function formatNextCrawlLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function formatCountdownMmSs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** CEO Live Mails: last sync + countdown + manual sync (always between toggle and KPIs). */
function CeoLiveSyncStrip({
  mailboxes,
  liveTrackDate,
  liveTrackTime,
  onLiveTrackDateChange,
  onLiveTrackTimeChange,
  onSyncNow,
  syncBusy,
  nextIngestionAtIso,
  scheduleReady,
  canManualSync = true,
  recentManualSyncAtMs = null,
}: {
  mailboxes: Mailbox[];
  liveTrackDate: string;
  liveTrackTime: string;
  onLiveTrackDateChange: (v: string) => void;
  onLiveTrackTimeChange: (v: string) => void;
  onSyncNow: () => void;
  syncBusy: boolean;
  /** From GET /settings/runtime — next UTC cron slot, matches server schedule. */
  nextIngestionAtIso: string | null;
  /** False until the first `/settings/runtime` response for this view. */
  scheduleReady: boolean;
  /** Employees rely on the scheduled crawl; CEO/managers can trigger a company run. */
  canManualSync?: boolean;
  /** Set when Run sync now succeeded; cleared when `last_synced_at` appears on a mailbox. */
  recentManualSyncAtMs?: number | null;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  void tick;
  const nowMs = Date.now();
  const connected = mailboxes.some((m) => isMailboxGmailConnected(m));
  const latestIso = pickLatestMailboxSyncIso(mailboxes);
  const awaitingAfterRun =
    !latestIso &&
    recentManualSyncAtMs != null &&
    nowMs - recentManualSyncAtMs < 120_000;
  const parsedNext = nextIngestionAtIso ? Date.parse(nextIngestionAtIso) : NaN;
  /** Always show the timer when the server gave a next slot — never replace it with “Running…” (lock state can stick). */
  const nextTickMs =
    nextIngestionAtIso && !Number.isNaN(parsedNext)
      ? Math.max(0, parsedNext - nowMs)
      : null;
  const trackingWindowPreview = trackingWindowPreviewLine(liveTrackDate, liveTrackTime);

  if (!connected) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/90 px-4 py-4 sm:px-5">
        <p className="text-sm font-semibold text-slate-800">Gmail &amp; AI sync</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Connect Gmail from the <strong className="font-medium text-slate-800">Your inbox</strong> card on this page
          (under the stats row). Then you&apos;ll see last sync time and can run a sync manually.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white px-4 py-4 shadow-card sm:px-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid flex-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tracking since</p>
            <p className="mt-1 text-base font-semibold text-slate-900">
              {trackingWindowPreview ?? 'Choose a start date'}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Last synced</p>
            <p className="mt-1 text-base font-semibold text-slate-900">
              {latestIso
                ? formatLiveSyncRelative(latestIso, nowMs)
                : syncBusy || awaitingAfterRun
                  ? 'Analyzing now'
                  : 'Not synced yet'}
            </p>
            {latestIso ? <p className="mt-0.5 text-xs text-slate-500">{formatLiveSyncAbsolute(latestIso)}</p> : null}
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Start date
            <input
              type="date"
              value={liveTrackDate}
              onChange={(e) => onLiveTrackDateChange(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Start time
            <input
              type="time"
              value={liveTrackTime}
              onChange={(e) => onLiveTrackTimeChange(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <button
            type="button"
            disabled={syncBusy || !canManualSync}
            onClick={onSyncNow}
            className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {syncBusy ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
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
  const { me, token, loading: authLoading, signOut: ctxSignOut, shellRoleHint } = useAuth();

  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Add mailbox form
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  /** CEO / manager: optional name + email for an extra `SELF` mailbox (any address), same API as team “add mailbox”. */
  const [showAddPersonalMailbox, setShowAddPersonalMailbox] = useState(false);

  /** Sidebar hash drives separate screens for CEO (manager mail / team mail). Department managers stay on the CEO-style home tab only. */
  const [myEmailTab, setMyEmailTab] = useState<'ceo' | 'manager' | 'team'>('ceo');

  const [aiSkippedMailboxId, setAiSkippedMailboxId] = useState('');
  const [aiSkippedRows, setAiSkippedRows] = useState<AiSkippedMailItem[]>([]);
  const [aiSkippedTotal, setAiSkippedTotal] = useState(0);
  const [aiSkippedCountSyncedAt, setAiSkippedCountSyncedAt] = useState<string | null>(null);
  const [aiSkippedLoading, setAiSkippedLoading] = useState(false);
  const [aiSkippedOffset, setAiSkippedOffset] = useState(0);
  const [aiSkippedClearingId, setAiSkippedClearingId] = useState<string | null>(null);
  const [skippedSelectedIds, setSkippedSelectedIds] = useState<Set<string>>(new Set());
  const [skippedBulkClearing, setSkippedBulkClearing] = useState(false);

  const [filterMailbox, setFilterMailbox] = useState('');
  /** CEO Manager-mail view: optional subset of manager inboxes to display/filter. */
  const [managerScopeMailboxIds, setManagerScopeMailboxIds] = useState<string[]>([]);
  /** CEO Employee-mail view: optional subset of employee inboxes to display/filter. */
  const [employeeScopeMailboxIds, setEmployeeScopeMailboxIds] = useState<string[]>([]);
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
  /** CEO Live Mails: manual GET /email-ingestion/run */
  const [liveSyncBusy, setLiveSyncBusy] = useState(false);
  /** After a successful run, `last_synced_at` can lag — show a calmer line until it appears. */
  const [liveSyncAwaitingTimestamp, setLiveSyncAwaitingTimestamp] = useState<number | null>(null);
  /** CEO Live: next cron from GET /settings/runtime (null = not loaded yet). */
  const [liveIngestSchedule, setLiveIngestSchedule] = useState<{
    nextIngestionAt: string | null;
  } | null>(null);
  /** CEO Live: local date/time → saved as `tracking_start_at` before each manual sync. */
  const [liveTrackDate, setLiveTrackDate] = useState('');
  const [liveTrackTime, setLiveTrackTime] = useState('');
  const liveTrackSourceRef = useRef<string>('');
  /** User dismissed the tracking-start dialog — don’t auto-reopen for that mailbox until they reconnect. */
  const trackingOnboardingDismissedRef = useRef<Set<string>>(new Set());
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

  /** Gmail connected but no tracking window — pick date/time first (then first sync + ongoing live mail). */
  const [trackingOnboarding, setTrackingOnboarding] = useState<{
    mailboxId: string;
    name: string;
    email: string;
  } | null>(null);
  const [onboardingDate, setOnboardingDate] = useState('');
  const [onboardingTime, setOnboardingTime] = useState('');
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  /** Same engine as Historical Search (SSE), then live `/email-ingestion/run`. */
  const [historicalBackfillUi, setHistoricalBackfillUi] = useState<HistoricalBackfillUi | null>(null);

  const runTrackingHistoricalWindowToNow = useCallback(
    async (
      t: string,
      opts: {
        employeeId: string;
        mailboxEmail: string;
        startIso: string;
        endIso: string;
        mailboxIndex?: number;
        mailboxTotal?: number;
      },
    ): Promise<void> => {
      const { employeeId, mailboxEmail, startIso, endIso, mailboxIndex, mailboxTotal } = opts;
      let sseError: string | null = null;
      setHistoricalBackfillUi({
        employeeId,
        mailboxEmail,
        mailboxIndex,
        mailboxTotal,
        phase: 'connecting',
        totalIds: 0,
        messageIndex: 0,
        messageTotal: 0,
        lastSubject: '',
        lastFrom: '',
        runningTracked: 0,
        runningSkippedAi: 0,
        runningAlreadySynced: 0,
        runningOutsideRange: 0,
        runningCcOnly: 0,
      });
      try {
        await apiPostSse(
          '/self-tracking/historical-fetch-stream',
          t,
          { start: startIso, end: endIso, employee_id: employeeId },
          (ev) => {
          const phase = String(ev.phase ?? '');
          if (phase === 'error') {
            sseError = String(ev.message ?? 'Inbox analysis failed.');
            setHistoricalBackfillUi((u) =>
              u ? { ...u, phase: 'error', error: sseError ?? u.error } : u,
            );
            return;
          }
          if (phase === 'listed') {
            const total = Number(ev.totalIds ?? 0);
            setHistoricalBackfillUi((u) =>
              u
                ? {
                    ...u,
                    phase: 'listed',
                    totalIds: total,
                    messageTotal: total,
                    messageIndex: 0,
                    runningTracked: 0,
                    runningSkippedAi: 0,
                    runningAlreadySynced: 0,
                    runningOutsideRange: 0,
                    runningCcOnly: 0,
                  }
                : u,
            );
            return;
          }
          if (phase === 'message') {
            setHistoricalBackfillUi((u) =>
              u
                ? {
                    ...u,
                    phase: 'message',
                    messageIndex: Number(ev.index ?? 0),
                    messageTotal: Number(ev.total ?? u.messageTotal),
                    lastSubject: String(ev.subject ?? u.lastSubject ?? ''),
                    lastFrom: String(ev.from ?? u.lastFrom ?? ''),
                  }
                : u,
            );
            return;
          }
          if (phase === 'ai_decision') {
            const relevant = Boolean(ev.relevant);
            const reasonRaw =
              ev.reason === null || ev.reason === undefined ? '' : String(ev.reason).trim();
            const ccOnly = ev.user_cc_only === true;
            setHistoricalBackfillUi((u) => {
              if (!u) return u;
              const tracked = u.runningTracked ?? 0;
              const skipAi = u.runningSkippedAi ?? 0;
              const already = u.runningAlreadySynced ?? 0;
              const outside = u.runningOutsideRange ?? 0;
              const cc = u.runningCcOnly ?? 0;
              let nt = tracked;
              let ns = skipAi;
              let na = already;
              let no = outside;
              let nc = cc;
              if (relevant) {
                nt += 1;
                if (ccOnly) nc += 1;
              } else if (reasonRaw === 'Already synced' || reasonRaw.includes('Already synced')) {
                na += 1;
              } else if (
                reasonRaw === 'Outside selected date range' ||
                reasonRaw.includes('Outside selected')
              ) {
                no += 1;
              } else {
                ns += 1;
              }
              return {
                ...u,
                phase: 'ai_decision',
                messageIndex: Number(ev.index ?? 0),
                messageTotal: Number(ev.total ?? u.messageTotal),
                lastSubject: String(ev.subject ?? ''),
                lastFrom: String(ev.from ?? ''),
                lastRelevant: relevant,
                lastReason: reasonRaw.length > 0 ? reasonRaw : null,
                runningTracked: nt,
                runningSkippedAi: ns,
                runningAlreadySynced: na,
                runningOutsideRange: no,
                runningCcOnly: nc,
              };
            });
            return;
          }
          if (phase === 'saving') {
            setHistoricalBackfillUi((u) =>
              u ? { ...u, phase: 'saving', savingCount: Number(ev.messageCount ?? 0) } : u,
            );
            return;
          }
          if (phase === 'recomputing') {
            setHistoricalBackfillUi((u) =>
              u
                ? { ...u, phase: 'recomputing', recomputingThreads: Number(ev.threadCount ?? 0) }
                : u,
            );
            return;
          }
          if (phase === 'complete') {
            const r = ev.result as Record<string, unknown> | undefined;
            setHistoricalBackfillUi((u) =>
              u
                ? {
                    ...u,
                    phase: 'complete',
                    complete: {
                      fetched: Number(r?.fetched_from_gmail ?? 0),
                      stored: Number(r?.stored_relevant ?? 0),
                      skipped: Number(r?.skipped_irrelevant ?? 0),
                      conversationsCreated: Number(r?.conversations_created ?? 0),
                    },
                  }
                : u,
            );
          }
          },
        );
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : 'The live analysis connection dropped before the server sent completion.';
        const friendly =
          'The live analysis connection dropped. Saved batches are kept, and you can run the same window again to continue/verify. ' +
          message;
        setHistoricalBackfillUi((u) =>
          u ? { ...u, phase: 'error', error: friendly } : u,
        );
        throw new Error(friendly);
      }
      if (sseError) {
        throw new Error(sseError);
      }
    },
    [],
  );

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

  const loadLiveIngestSchedule = useCallback(async () => {
    if (!token) return;
    const res = await apiFetch('/settings/runtime', token);
    if (!res.ok) {
      setLiveIngestSchedule({ nextIngestionAt: null });
      return;
    }
    const rt = (await res.json()) as RuntimeStatus;
    setLiveIngestSchedule({
      nextIngestionAt: rt.nextIngestionAt ?? null,
    });
  }, [token]);

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
    /** My Email: CEO full workspace; HEAD/EMPLOYEE — scoped mailboxes and follow-ups. */
    if (
      me.role !== 'CEO' &&
      !isDepartmentManagerRole(me.role) &&
      me.role !== 'EMPLOYEE'
    ) {
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
      if (typeof window === 'undefined') return;
      const h = window.location.hash;
      /** Department managers use the same single-inbox surface as the CEO home tab — no team/manager sub-views here. */
      if (me && isDepartmentManagerRole(me.role)) {
        if (h === '#manager-mailboxes' || h === '#team-mailboxes-ceo') {
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        }
        setMyEmailTab('ceo');
        return;
      }
      if (h === '#manager-mailboxes') setMyEmailTab('manager');
      else if (h === '#team-mailboxes-ceo') setMyEmailTab('team');
      else setMyEmailTab('ceo');
    };
    syncTab();
    window.addEventListener('hashchange', syncTab);
    return () => window.removeEventListener('hashchange', syncTab);
  }, [me]);

  useEffect(() => {
    if (myEmailTab !== 'team') setShowAddForm(false);
  }, [myEmailTab]);

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

  /** Popup OAuth: main tab keeps session; child window posts here when Google finishes. */
  useEffect(() => {
    if (!token) return;
    return subscribeGmailOAuthComplete(({ next, connected, employee_id }) => {
      if (connected) {
        setSuccess('Gmail connected successfully.');
      }
      void loadDashboard(token);
      const q = new URLSearchParams();
      if (connected) q.set('connected', '1');
      if (employee_id) q.set('employee_id', employee_id);
      const qs = q.toString();
      router.replace(qs ? `${next}?${qs}` : next);
    });
  }, [token, loadDashboard, router]);

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
    openGmailOAuthWindow(body.url);
  }

  /** Signed-in user’s own inbox row (CEO or department manager) — uses session profile for POST /self-tracking/mailboxes. */
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
      setShowAddPersonalMailbox(false);
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
      'Backfilling your tracking window (Historical Search engine), then company sync — see the progress card below.',
    );

    try {
      await runTrackingHistoricalWindowToNow(token, {
        employeeId: mb.id,
        mailboxEmail: mb.email,
        startIso: selectedTrackingIso,
        endIso: new Date().toISOString(),
      });
    } catch (e) {
      setHistoricalBackfillUi(null);
      setPipeline(null);
      setError(e instanceof Error ? e.message : 'Could not analyze your tracking window.');
      return;
    }
    setHistoricalBackfillUi(null);

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
          'Email syncing is off in Settings. Turn it on, then try Start again.',
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
   * Your inbox: prefer `linked_employee_id` from `/auth/me` (manager portal email often ≠ `employees.email`).
   * Otherwise match signed-in email — self-tracking or org row with the same address.
   */
  const ownMailboxes = useMemo(() => {
    /** CEO: only your own `SELF` rows — manager personal inboxes stay under “Manager mail”, not here. */
    if (me?.role === 'CEO') {
      const selfs = mailboxes.filter(
        (mb) => mb.mailbox_type === 'SELF' && mb.is_manager_mailbox !== true,
      );
      if (ceoEmailNorm) {
        const byCeoEmail = selfs.filter(
          (mb) => mb.email.trim().toLowerCase() === ceoEmailNorm,
        );
        if (byCeoEmail.length > 0) return byCeoEmail;
      }
      // Safe fallback: if there is only one SELF row, treat it as CEO inbox.
      if (selfs.length === 1) return selfs;
      return [];
    }
    const linkId = me?.linked_employee_id?.trim();
    /** Department manager: include linked employee mailbox (if any) and SELF rows. */
    if (isDepartmentManagerRole(me?.role)) {
      const mine: Mailbox[] = [];
      if (linkId) {
        const linked = mailboxes.find((mb) => mb.id === linkId);
        if (linked) mine.push(linked);
      }
      const selfs = mailboxes.filter((mb) => mb.mailbox_type === 'SELF');
      for (const mb of selfs) {
        if (!mine.some((m) => m.id === mb.id)) mine.push(mb);
      }
      if (mine.length > 0) return mine;
    }
    if (linkId) {
      const byLink = mailboxes.filter((mb) => mb.id === linkId);
      if (byLink.length > 0) return byLink;
    }
    if (ceoEmailNorm === '') return [];
    return mailboxes.filter((mb) => mb.email.trim().toLowerCase() === ceoEmailNorm);
  }, [mailboxes, ceoEmailNorm, me?.linked_employee_id, me?.role]);

  useEffect(() => {
    if (pickLatestMailboxSyncIso(ownMailboxes)) {
      setLiveSyncAwaitingTimestamp(null);
    }
  }, [ownMailboxes]);

  /** App shell strip: green “In sync” only when *your* inbox row has Gmail connected (not company crawl alone). */
  const headerInboxGmailConnected = useMemo(
    () => ownMailboxes.some((m) => isMailboxGmailConnected(m)),
    [ownMailboxes],
  );
  const headerOwnInboxLastSyncLabel = useMemo(() => {
    let bestIso: string | null = null;
    let bestMs = 0;
    for (const m of ownMailboxes) {
      const raw = m.last_gmail_sync_at ?? m.last_synced_at;
      if (!raw) continue;
      const t = Date.parse(raw);
      if (Number.isFinite(t) && t >= bestMs) {
        bestMs = t;
        bestIso = raw;
      }
    }
    if (!bestIso) return null;
    return `Your inbox · Last sync ${new Date(bestIso).toLocaleString()}`;
  }, [ownMailboxes]);

  /** My Email inbox chrome for CEO, department managers, and employees. */
  const showFullInboxChrome =
    me?.role === 'CEO' || isDepartmentManagerRole(me?.role) || me?.role === 'EMPLOYEE';
  /** Manual "Run sync now" — CEO/HEAD (company crawl) or employee (their mailbox only via API). */
  const canRunMyMailboxSync =
    me?.role === 'CEO' || isDepartmentManagerRole(me?.role) || me?.role === 'EMPLOYEE';

  /** After Gmail connects: require a tracking start (date + time) before any analysis/sync — same mental model as Historical “pick a window”. */
  useEffect(() => {
    if (!showFullInboxChrome || !dash?.mailboxes || authLoading) return;
    if (trackingOnboarding != null) return;
    if (onboardingBusy) return;
    const candidate = ownMailboxes.find(
      (m) => isMailboxGmailConnected(m) && !m.tracking_start_at?.trim(),
    );
    if (!candidate) return;
    if (trackingOnboardingDismissedRef.current.has(candidate.id)) return;
    setTrackingOnboarding({
      mailboxId: candidate.id,
      name: candidate.name,
      email: candidate.email,
    });
    const now = new Date();
    setOnboardingDate(formatLocalYmd(now));
    setOnboardingTime(formatLocalHm(now));
  }, [showFullInboxChrome, dash?.mailboxes, authLoading, ownMailboxes, trackingOnboarding, onboardingBusy]);

  useEffect(() => {
    if (!showFullInboxChrome) return;
    const primary = ownMailboxes.find((m) => isMailboxGmailConnected(m)) ?? ownMailboxes[0];
    if (!primary) return;
    const key = `${primary.id}:${primary.tracking_start_at ?? ''}`;
    if (liveTrackSourceRef.current === key) return;
    liveTrackSourceRef.current = key;
    const { date, time } = isoToLiveTrackingDateTime(primary.tracking_start_at);
    setLiveTrackDate(date);
    setLiveTrackTime(time);
  }, [showFullInboxChrome, ownMailboxes]);

  useEffect(() => {
    if (!token || !showFullInboxChrome || myEmailTab !== 'ceo') return;
    let cancelled = false;
    void loadLiveIngestSchedule();
    const id = window.setInterval(() => {
      if (!cancelled) void loadLiveIngestSchedule();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, showFullInboxChrome, myEmailTab, loadLiveIngestSchedule]);

  useEffect(() => {
    setAiSkippedOffset(0);
  }, [aiSkippedMailboxId]);

  const loadAiSkippedMails = useCallback(async (opts?: { silent?: boolean }) => {
    if (!token || !aiSkippedMailboxId) return;
    const silent = Boolean(opts?.silent);
    if (!silent) setAiSkippedLoading(true);
    try {
      const params = new URLSearchParams({
        employee_id: aiSkippedMailboxId,
        limit: String(AI_SKIPPED_PAGE),
        offset: String(aiSkippedOffset),
      });
      const res = await apiFetch(`/self-tracking/ai-skipped-mails?${params}`, token);
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, 'Could not load skipped messages.'));
      }
      const data = (await res.json()) as { items?: AiSkippedMailItem[]; total?: number };
      setAiSkippedRows(Array.isArray(data.items) ? data.items : []);
      setAiSkippedTotal(typeof data.total === 'number' ? data.total : 0);
      setAiSkippedCountSyncedAt(new Date().toISOString());
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : 'Could not load messages Inbox AI skipped.');
      }
    } finally {
      if (!silent) setAiSkippedLoading(false);
    }
  }, [token, aiSkippedMailboxId, aiSkippedOffset]);

  /** Keep the Skipped tab badge accurate even before opening that tab. */
  const loadAiSkippedCount = useCallback(async () => {
    if (!token || !aiSkippedMailboxId) return;
    try {
      const params = new URLSearchParams({
        employee_id: aiSkippedMailboxId,
        limit: '1',
        offset: '0',
      });
      const res = await apiFetch(`/self-tracking/ai-skipped-mails?${params}`, token);
      if (!res.ok) return;
      const data = (await res.json()) as { total?: number };
      setAiSkippedTotal(typeof data.total === 'number' ? data.total : 0);
      setAiSkippedCountSyncedAt(new Date().toISOString());
    } catch {
      // Non-blocking badge refresh; keep current value on transient failures.
    }
  }, [token, aiSkippedMailboxId]);

  const clearAiSkipEntry = useCallback(
    async (providerMessageId: string) => {
      if (!token || !aiSkippedMailboxId) return;
      setAiSkippedClearingId(providerMessageId);
      setError(null);
      try {
        const params = new URLSearchParams({
          employee_id: aiSkippedMailboxId,
          provider_message_id: providerMessageId,
        });
        const res = await apiFetch(`/self-tracking/ai-skipped-mails/reanalyze?${params}`, token, {
          method: 'POST',
        });
        if (!res.ok) {
          setError(await readApiErrorMessage(res, 'Could not reanalyze this thread.'));
          return;
        }
        const body = (await res.json()) as { outcome?: string };
        setSkippedSelectedIds((prev) => {
          const n = new Set(prev);
          n.delete(providerMessageId);
          return n;
        });
        await loadAiSkippedMails();
        await loadDashboard(token);
        setSuccess(
          body.outcome === 'classified'
            ? 'Reanalyzed and added to your follow-up workspace.'
            : body.outcome === 'already_in_portal'
              ? 'This thread is already in your follow-up workspace.'
              : 'Reanalyzed. AI still could not classify this thread confidently.',
        );
      } finally {
        setAiSkippedClearingId(null);
      }
    },
    [token, aiSkippedMailboxId, loadAiSkippedMails, loadDashboard],
  );

  const clearSelectedSkippedSkips = useCallback(async () => {
    if (!token || !aiSkippedMailboxId || skippedSelectedIds.size === 0) return;
    const ids = [...skippedSelectedIds];
    if (
      !window.confirm(
        `Reanalyze ${ids.length} skipped message(s)?`,
      )
    ) {
      return;
    }
    setSkippedBulkClearing(true);
    setError(null);
    try {
      let ok = 0;
      let fail = 0;
      for (const providerMessageId of ids) {
        const params = new URLSearchParams({
          employee_id: aiSkippedMailboxId,
          provider_message_id: providerMessageId,
        });
        const res = await apiFetch(`/self-tracking/ai-skipped-mails/reanalyze?${params}`, token, {
          method: 'POST',
        });
        if (res.ok) ok++;
        else fail++;
      }
      setSkippedSelectedIds(new Set());
      if (fail > 0) {
        setError(`${fail} message(s) could not be reanalyzed (${ok} completed).`);
      } else {
        setSuccess(`${ok} skipped thread${ok === 1 ? '' : 's'} reanalyzed.`);
      }
      await loadAiSkippedMails();
      await loadDashboard(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk reanalysis failed.');
    } finally {
      setSkippedBulkClearing(false);
    }
  }, [token, aiSkippedMailboxId, skippedSelectedIds, loadAiSkippedMails, loadDashboard]);

  useEffect(() => {
    if (!showFullInboxChrome || mailTab !== 'skipped') return;
    if (!token || !aiSkippedMailboxId) return;
    void loadAiSkippedMails();
  }, [
    showFullInboxChrome,
    mailTab,
    token,
    aiSkippedMailboxId,
    aiSkippedOffset,
    loadAiSkippedMails,
  ]);

  useEffect(() => {
    if (!showFullInboxChrome) return;
    if (!token || !aiSkippedMailboxId) return;
    void loadAiSkippedCount();
  }, [showFullInboxChrome, token, aiSkippedMailboxId, loadAiSkippedCount]);

  /** Keep skipped badge fresh even when user stays on non-skipped tabs. */
  useEffect(() => {
    if (!showFullInboxChrome) return;
    if (!token || !aiSkippedMailboxId) return;
    const POLL_MS = 20_000;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadAiSkippedCount();
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [showFullInboxChrome, token, aiSkippedMailboxId, loadAiSkippedCount]);

  useEffect(() => {
    if (!showFullInboxChrome) return;
    if (!token || !aiSkippedMailboxId) return;
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadAiSkippedCount();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [showFullInboxChrome, token, aiSkippedMailboxId, loadAiSkippedCount]);

  /** Drop selections for rows that disappeared after refresh or pagination. */
  useEffect(() => {
    const pageIds = new Set(aiSkippedRows.map((r) => r.provider_message_id));
    setSkippedSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pageIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [aiSkippedRows]);

  useEffect(() => {
    setSkippedSelectedIds(new Set());
  }, [aiSkippedMailboxId, aiSkippedOffset]);

  /** Background refresh while Skipped tab is open — no manual Refresh required. */
  useEffect(() => {
    if (!showFullInboxChrome || mailTab !== 'skipped') return;
    if (!token || !aiSkippedMailboxId) return;
    const POLL_MS = 20_000;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadAiSkippedMails({ silent: true });
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [showFullInboxChrome, mailTab, token, aiSkippedMailboxId, loadAiSkippedMails]);

  useEffect(() => {
    if (!showFullInboxChrome || mailTab !== 'skipped') return;
    if (!token || !aiSkippedMailboxId) return;
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadAiSkippedMails({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [showFullInboxChrome, mailTab, token, aiSkippedMailboxId, loadAiSkippedMails]);

  /** Department managers only — matches HEAD user in org (not every IC). */
  const managerMailboxes = useMemo(() => {
    const raw = mailboxes.filter((mb) => {
      if (ceoEmailNorm !== '' && mb.email.trim().toLowerCase() === ceoEmailNorm) {
        return false;
      }
      return mb.is_manager_mailbox === true;
    });
    return dedupeMailboxesByEmailPreferPrimary(raw);
  }, [mailboxes, ceoEmailNorm]);

  useEffect(() => {
    const allowed = new Set(managerMailboxes.map((m) => m.id));
    setManagerScopeMailboxIds((prev) => prev.filter((id) => allowed.has(id)));
  }, [managerMailboxes]);

  const managerScopedMailboxes = useMemo(() => {
    if (managerScopeMailboxIds.length === 0) return managerMailboxes;
    const selected = new Set(managerScopeMailboxIds);
    return managerMailboxes.filter((m) => selected.has(m.id));
  }, [managerMailboxes, managerScopeMailboxIds]);

  /**
   * Employee mail: TEAM mailboxes except CEO self. Omit **canonical** manager inboxes only
   * (`is_manager_mailbox` and not a secondary roster row) — dual-role heads keep their
   * `roster_duplicate` row here. Dedupe by email for duplicate roster rows.
   */
  const teamMailboxesOnly = useMemo(() => {
    const raw = mailboxes.filter((mb) => {
      const emailNorm = mb.email.trim().toLowerCase();
      if (ceoEmailNorm !== '' && emailNorm === ceoEmailNorm) {
        return false;
      }
      if (mb.mailbox_type === 'SELF') return false;
      if (mb.is_manager_mailbox === true && mb.roster_duplicate !== true) return false;
      return true;
    });
    return dedupeMailboxesByEmailPreferPrimary(raw);
  }, [mailboxes, ceoEmailNorm]);

  useEffect(() => {
    const allowed = new Set(teamMailboxesOnly.map((m) => m.id));
    setEmployeeScopeMailboxIds((prev) => prev.filter((id) => allowed.has(id)));
  }, [teamMailboxesOnly]);

  const teamScopedMailboxes = useMemo(() => {
    if (employeeScopeMailboxIds.length === 0) return teamMailboxesOnly;
    const selected = new Set(employeeScopeMailboxIds);
    return teamMailboxesOnly.filter((m) => selected.has(m.id));
  }, [teamMailboxesOnly, employeeScopeMailboxIds]);

  const skippedMailboxCandidates = useMemo(() => {
    if (myEmailTab === 'ceo') return ownMailboxes;
    if (myEmailTab === 'manager') return managerScopedMailboxes;
    return teamScopedMailboxes;
  }, [myEmailTab, ownMailboxes, managerScopedMailboxes, teamScopedMailboxes]);

  useEffect(() => {
    if (skippedMailboxCandidates.length === 0) {
      setAiSkippedMailboxId('');
      return;
    }
    setAiSkippedMailboxId((prev) => {
      if (prev && skippedMailboxCandidates.some((m) => m.id === prev)) return prev;
      return (
        skippedMailboxCandidates.find((m) => isMailboxGmailConnected(m))?.id ??
        skippedMailboxCandidates[0].id
      );
    });
  }, [skippedMailboxCandidates]);

  const scopeMailboxIds = useMemo(() => {
    const ids = new Set<string>();
    if (myEmailTab === 'ceo') {
      ownMailboxes.forEach((m) => ids.add(m.id));
    } else if (myEmailTab === 'manager') {
      managerScopedMailboxes.forEach((m) => ids.add(m.id));
    } else {
      teamScopedMailboxes.forEach((m) => ids.add(m.id));
    }
    return ids;
  }, [myEmailTab, ownMailboxes, managerScopedMailboxes, teamScopedMailboxes]);

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

  /**
   * Same as hiding LOW, except MISSED SLA rows still surface in Need reply — otherwise
   * automated-looking mail can be LOW + MISSED and show in Missed SLA (6) but Need reply (0).
   */
  const scopedExcludingLowUnlessMissed = useMemo(
    () =>
      hideLowPriority
        ? scopedConversations.filter(
            (c) => c.priority !== 'LOW' || c.follow_up_status === 'MISSED',
          )
        : scopedConversations,
    [hideLowPriority, scopedConversations],
  );

  const kpiNeedReplyCount = useMemo(
    () =>
      scopedExcludingLowUnlessMissed.filter(
        (c) =>
          needsMyReply(c) &&
          (!HIDE_STALE_NEED_REPLY || !isStaleNeedReplyByClientMessage(c, STALE_NEED_REPLY_DAYS)),
      ).length,
    [scopedExcludingLowUnlessMissed],
  );
  const kpiWaitingCount = useMemo(
    () => withoutLowScoped.filter((c) => isWaitingOnThem(c)).length,
    [withoutLowScoped],
  );

  /** Matches the Low / noise tab (priority LOW in this mailbox scope). */
  const kpiLowNoiseTabCount = useMemo(
    () => scopedConversations.filter((c) => c.priority === 'LOW').length,
    [scopedConversations],
  );

  /** Matches the All threads tab row count (respects hide-low setting). */
  const kpiAllThreadsTabCount = useMemo(
    () =>
      hideLowPriority
        ? scopedConversations.filter((c) => c.priority !== 'LOW').length
        : scopedConversations.length,
    [hideLowPriority, scopedConversations],
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
      case 'skipped':
        return [];
      case 'noise':
        return scopedConversations.filter((c) => c.priority === 'LOW');
      case 'action':
        return scopedExcludingLowUnlessMissed.filter(
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
    scopedExcludingLowUnlessMissed,
    ccScopedRows,
    hideLowPriority,
    allTabStatus,
    allTabPriority,
  ]);

  const searchFilteredSkippedRows = useMemo(() => {
    const q = threadSearch.trim().toLowerCase();
    if (!q) return aiSkippedRows;
    return aiSkippedRows.filter((row) => {
      const sub = (row.subject ?? '').toLowerCase();
      const from = (row.from_email ?? '').toLowerCase();
      const kind = (row.skip_kind ?? '').toLowerCase();
      const reason = (row.skip_reason ?? '').toLowerCase();
      const reasonCode = (row.skip_reason_code ?? '').toLowerCase();
      const mid = (row.provider_message_id ?? '').toLowerCase();
      return (
        sub.includes(q) ||
        from.includes(q) ||
        kind.includes(q) ||
        reason.includes(q) ||
        reasonCode.includes(q) ||
        mid.includes(q)
      );
    });
  }, [aiSkippedRows, threadSearch]);

  const toggleSelectAllSkippedFiltered = useCallback(() => {
    const ids = searchFilteredSkippedRows.map((r) => r.provider_message_id);
    setSkippedSelectedIds((prev) => {
      const all = ids.length > 0 && ids.every((id) => prev.has(id));
      if (all) {
        const n = new Set(prev);
        ids.forEach((id) => n.delete(id));
        return n;
      }
      return new Set([...prev, ...ids]);
    });
  }, [searchFilteredSkippedRows]);

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

  const pagedTabRows = useMemo(
    () => searchFilteredTabRowsSorted.slice(0, mailListPage * MAIL_PAGE_SIZE),
    [searchFilteredTabRowsSorted, mailListPage],
  );
  const hasMoreTabRows = searchFilteredTabRowsSorted.length > pagedTabRows.length;
  const activeTabExplanation =
    mailTab === 'action'
      ? 'Conversations waiting for your response.'
      : mailTab === 'waiting'
        ? 'Conversations where you already replied.'
        : mailTab === 'cc'
          ? 'Conversations where you were included for awareness.'
          : mailTab === 'closed'
            ? 'Conversations already handled.'
            : mailTab === 'noise'
              ? 'Conversations that do not need urgent attention.'
              : mailTab === 'skipped'
                ? 'Conversations AI could not confidently categorize.'
                : 'Conversations in your tracking window.';

  const syncEmployeeIdsParam = useMemo(() => {
    const m = filterMailbox.trim();
    if (m) return m;
    return [...scopeMailboxIds].sort().join(',');
  }, [filterMailbox, scopeMailboxIds]);

  const runLiveIngestionNow = useCallback(async () => {
    if (!token) return;
    if (!canRunMyMailboxSync) return;
    const trackingIso = liveTrackingDateTimeToIso(liveTrackDate, liveTrackTime);
    if (!trackingIso) {
      setError('Choose a valid start date and time for live tracking.');
      return;
    }
    const targets = ownMailboxes.filter((m) => isMailboxGmailConnected(m));
    if (targets.length === 0) {
      setError('Connect Gmail on your inbox card first.');
      return;
    }
    setLiveSyncBusy(true);
    setError(null);
    try {
      for (const mb of targets) {
        const patchRes = await apiFetch(
          `/employees/${encodeURIComponent(mb.id)}/tracking-start`,
          token,
          {
            method: 'PATCH',
            body: JSON.stringify({ tracking_start_at: trackingIso }),
          },
        );
        if (!patchRes.ok) {
          const j = await patchRes.json().catch(() => ({}));
          setError(
            (j as { message?: string }).message ??
              `Could not save tracking start for ${mb.email}.`,
          );
          return;
        }
      }
      liveTrackSourceRef.current = `${targets[0].id}:${trackingIso}`;
      const endIso = new Date().toISOString();
      for (let i = 0; i < targets.length; i++) {
        const mb = targets[i];
        try {
          await runTrackingHistoricalWindowToNow(token, {
            employeeId: mb.id,
            mailboxEmail: mb.email,
            startIso: trackingIso,
            endIso,
            mailboxIndex: i + 1,
            mailboxTotal: targets.length,
          });
        } catch (e) {
          setError(
            e instanceof Error
              ? e.message
              : `Could not analyze the tracking window for ${mb.email}.`,
          );
          return;
        }
      }
      setHistoricalBackfillUi(null);
      const runReq = apiFetch('/email-ingestion/run', token);
      const timed = await Promise.race([
        runReq.then((res) => ({ kind: 'response' as const, res })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          window.setTimeout(() => resolve({ kind: 'timeout' }), 5000),
        ),
      ]);
      if (timed.kind === 'timeout') {
        setLiveSyncAwaitingTimestamp(Date.now());
        setSuccess('Sync started. It is still running in background; refreshing inbox now.');
        await loadDashboard(token, syncEmployeeIdsParam || undefined);
        void loadLiveIngestSchedule();
        window.setTimeout(() => {
          void loadDashboard(token, syncEmployeeIdsParam || undefined);
          void loadLiveIngestSchedule();
        }, 2500);
        return;
      }
      const res = timed.res;
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(j.message ?? 'Could not run sync.');
        return;
      }
      if (j.status === 'skipped') {
        setError(
          j.message ??
            'Email syncing is off. Open Settings, turn it on, then try Sync now again.',
        );
        return;
      }
      setLiveSyncAwaitingTimestamp(Date.now());
      if (j.status === 'running') {
        setSuccess('A sync is already running — wait a moment, then refresh.');
      } else {
        setSuccess('Sync finished. Updating your inbox…');
      }
      await loadDashboard(token, syncEmployeeIdsParam || undefined);
      void loadLiveIngestSchedule();
      window.setTimeout(() => {
        void loadDashboard(token, syncEmployeeIdsParam || undefined);
        void loadLiveIngestSchedule();
      }, 2500);
    } finally {
      setLiveSyncBusy(false);
    }
  }, [
    token,
    canRunMyMailboxSync,
    loadDashboard,
    loadLiveIngestSchedule,
    syncEmployeeIdsParam,
    liveTrackDate,
    liveTrackTime,
    ownMailboxes,
    runTrackingHistoricalWindowToNow,
  ]);

  const submitTrackingOnboarding = useCallback(async () => {
    if (!token || !trackingOnboarding) return;
    const trackingIso = liveTrackingDateTimeToIso(onboardingDate, onboardingTime);
    if (!trackingIso) {
      setError('Choose a valid date and time for live tracking to begin.');
      return;
    }
    setOnboardingBusy(true);
    setError(null);
    try {
      const patchRes = await apiFetch(
        `/employees/${encodeURIComponent(trackingOnboarding.mailboxId)}/tracking-start`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ tracking_start_at: trackingIso }),
        },
      );
      if (!patchRes.ok) {
        setError(await readApiErrorMessage(patchRes, 'Could not save your tracking window.'));
        return;
      }
      const endIso = new Date().toISOString();
      try {
        await runTrackingHistoricalWindowToNow(token, {
          employeeId: trackingOnboarding.mailboxId,
          mailboxEmail: trackingOnboarding.email,
          startIso: trackingIso,
          endIso,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not analyze your tracking window.');
        return;
      }
      setHistoricalBackfillUi(null);
      liveTrackSourceRef.current = `${trackingOnboarding.mailboxId}:${trackingIso}`;
      const parts = isoToLiveTrackingDateTime(trackingIso);
      setLiveTrackDate(parts.date);
      setLiveTrackTime(parts.time);
      const runReq = apiFetch('/email-ingestion/run', token);
      const timed = await Promise.race([
        runReq.then((res) => ({ kind: 'response' as const, res })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          window.setTimeout(() => resolve({ kind: 'timeout' }), 5000),
        ),
      ]);
      if (timed.kind === 'timeout') {
        setLiveSyncAwaitingTimestamp(Date.now());
        setSuccess('Tracking window saved. Sync is running in the background — your inbox will fill in shortly.');
        await loadDashboard(token, syncEmployeeIdsParam || undefined);
        void loadLiveIngestSchedule();
        setTrackingOnboarding(null);
        window.setTimeout(() => {
          void loadDashboard(token, syncEmployeeIdsParam || undefined);
          void loadLiveIngestSchedule();
        }, 2500);
        return;
      }
      const res = timed.res;
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(j.message ?? 'Tracking saved, but sync could not start. Use Run sync now below.');
        await loadDashboard(token, syncEmployeeIdsParam || undefined);
        setTrackingOnboarding(null);
        return;
      }
      if (j.status === 'skipped') {
        setError(
          j.message ??
            'Tracking saved. Turn on email syncing in Settings, then use Sync now.',
        );
        await loadDashboard(token, syncEmployeeIdsParam || undefined);
        setTrackingOnboarding(null);
        return;
      }
      setLiveSyncAwaitingTimestamp(Date.now());
      if (j.status === 'running') {
        setSuccess('Tracking window saved. A sync is already running — wait a moment, then refresh.');
      } else {
        setSuccess('Tracking window saved. First sync finished — refreshing your inbox…');
      }
      await loadDashboard(token, syncEmployeeIdsParam || undefined);
      void loadLiveIngestSchedule();
      setTrackingOnboarding(null);
      window.setTimeout(() => {
        void loadDashboard(token, syncEmployeeIdsParam || undefined);
        void loadLiveIngestSchedule();
      }, 2500);
    } finally {
      setOnboardingBusy(false);
    }
  }, [
    token,
    trackingOnboarding,
    onboardingDate,
    onboardingTime,
    loadDashboard,
    loadLiveIngestSchedule,
    syncEmployeeIdsParam,
    runTrackingHistoricalWindowToNow,
  ]);

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
    if (
      !token ||
      !me ||
      (me.role !== 'CEO' &&
        !isDepartmentManagerRole(me.role) &&
        me.role !== 'EMPLOYEE')
    )
      return;
    const id = window.setTimeout(() => {
      void loadDashboard(token, syncEmployeeIdsParam || undefined);
    }, 180);
    return () => clearTimeout(id);
  }, [token, me, filterMailbox, loadDashboard, syncEmployeeIdsParam, myEmailTab]);

  /** CEO inbox tab: while historical backfill writes threads, refresh dashboard so stat cards and tab counts catch up. */
  useEffect(() => {
    if (!token || me?.role !== 'CEO' || myEmailTab !== 'ceo') return;
    const phase = historicalBackfillUi?.phase;
    if (phase !== 'saving' && phase !== 'recomputing') return;
    void loadDashboard(token, syncEmployeeIdsParam || undefined);
    const id = window.setInterval(() => {
      void loadDashboard(token, syncEmployeeIdsParam || undefined);
    }, 2000);
    return () => clearInterval(id);
  }, [
    token,
    me?.role,
    myEmailTab,
    historicalBackfillUi?.phase,
    historicalBackfillUi?.employeeId,
    loadDashboard,
    syncEmployeeIdsParam,
  ]);

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
    if (myEmailTab === 'manager') return managerScopedMailboxes;
    return teamScopedMailboxes;
  }, [myEmailTab, ownMailboxes, managerScopedMailboxes, teamScopedMailboxes]);

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

  const shellRoleForLoading = me?.role ?? shellRoleHint ?? 'EMPLOYEE';

  if (!me || authLoading) {
    return (
      <AppShell
        role={shellRoleForLoading}
        title="My Email"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (me.role === 'PLATFORM_ADMIN') {
    return (
      <AppShell
        role="PLATFORM_ADMIN"
        title="My Email"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  if (me.role !== 'CEO' && !isDepartmentManagerRole(me.role) && me.role !== 'EMPLOYEE') {
    return (
      <AppShell
        role={me.role}
        title="My Email"
        subtitle=""
        onSignOut={() => void ctxSignOut()}
      >
        <PortalPageLoader variant="embedded" />
      </AppShell>
    );
  }

  const pageTitle =
    me.role === 'CEO'
      ? myEmailTab === 'manager'
        ? 'Manager mail'
        : myEmailTab === 'team'
          ? 'Team mail'
          : 'My Email'
      : 'My Email';
  const shellSubtitle =
    me.role === 'CEO'
      ? myEmailTab === 'ceo'
        ? 'Your CEO inbox only. Mail in your tracking window appears here for follow-up.'
        : myEmailTab === 'manager'
          ? 'Department heads’ tracked inboxes.'
          : 'Individual contributors and other org mailboxes (not your CEO login).'
      : isDepartmentManagerRole(me.role)
        ? 'Your inbox only. Mail in your tracking window appears here for follow-up.'
        : me.role === 'EMPLOYEE'
          ? 'Your inbox: live mail and follow-ups — same My Email tools as leadership, scoped to your mailbox. Connect Gmail here, run sync when you need it, and track SLAs on your threads.'
          : 'My Email';

  const bulkDeleteBarPct =
    bulkDeleteProgress == null || bulkDeleteProgress.total <= 0
      ? 0
      : Math.min(
          100,
          Math.round((100 * bulkDeleteProgress.done) / bulkDeleteProgress.total),
        );

  /** CEO · My Email (default inbox tab): extra AI progress + live category refresh — not manager/team views. */
  const ceoMyEmailAiPortalDetail = me.role === 'CEO' && myEmailTab === 'ceo';

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
        {historicalBackfillUi?.employeeId === mbId ? (
          <HistoricalBackfillProgressBlock
            ui={historicalBackfillUi}
            windowLine={
              pipeline.trackingStartAt ? absoluteTime(pipeline.trackingStartAt) : null
            }
            ceoPortalDetail={ceoMyEmailAiPortalDetail}
          />
        ) : null}
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
              ? '3. Smart inbox filtering completed'
              : serverSyncPhase
                ? '3. Smart filtering checks each message (with thread context) as mail is ingested'
                : '3. Smart inbox filtering...'}
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
      isActive={headerInboxGmailConnected}
      mailboxCrawlEnabled={
        liveIngestSchedule == null ? undefined : liveIngestSchedule.nextIngestionAt != null
      }
      lastSyncLabel={headerOwnInboxLastSyncLabel}
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
              Import without filtering?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Smart filtering cannot run until the items below are fixed. Otherwise you can still sync and we
              will store <strong className="font-medium">all</strong> mail in your tracking window (no filter).
            </p>
            {ingestWithoutAiPrompt.blockers.length > 0 ? (
              <ul className="mt-3 list-inside list-disc space-y-1.5 rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2.5 text-left text-xs text-amber-950">
                {ingestWithoutAiPrompt.blockers.map((line, i) => (
                  <li key={`${i}-${line.slice(0, 40)}`}>{line}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">Prefer filtering? Fix the list above, then click Start again.</p>
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
      {trackingOnboarding && (
        <div
          className="fixed inset-0 z-[202] flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tracking-onboarding-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-brand-200 bg-white p-6 shadow-2xl">
            <h2 id="tracking-onboarding-title" className="text-lg font-semibold text-slate-900">
              {onboardingBusy
                ? 'Analyzing your inbox (same engine as Historical Search)'
                : 'Start tracking your emails'}
            </h2>
            {onboardingBusy ? (
              <>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  We pull Gmail from your chosen start through{' '}
                  <strong className="font-medium text-slate-900">right now</strong>, run Inbox AI on each
                  message (identical flow to Historical Search), store follow-ups, then hand off to{' '}
                  <strong className="font-medium text-slate-900">live</strong> sync for new mail only.
                </p>
                <HistoricalBackfillProgressBlock
                  ui={historicalBackfillUi}
                  windowLine={trackingWindowPreviewLine(onboardingDate, onboardingTime)}
                  ceoPortalDetail={ceoMyEmailAiPortalDetail}
                />
                {!historicalBackfillUi ? (
                  <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-brand-600 to-violet-600" />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Choose the date and time from which AI should analyze your conversations.
              </p>
            )}
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Start date
                <input
                  type="date"
                  value={onboardingDate}
                  onChange={(e) => setOnboardingDate(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Start time
                <input
                  type="time"
                  value={onboardingTime}
                  onChange={(e) => setOnboardingTime(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </label>
            </div>
            {!onboardingBusy ? (
              <p className="mt-2 text-[11px] leading-snug text-slate-500">
                Uses your device&apos;s timezone. You can change this later from the dashboard header.
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  trackingOnboardingDismissedRef.current.add(trackingOnboarding.mailboxId);
                  setTrackingOnboarding(null);
                }}
                disabled={onboardingBusy}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => void submitTrackingOnboarding()}
                disabled={onboardingBusy}
                className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-md hover:opacity-95 disabled:opacity-50"
              >
                {onboardingBusy ? 'Analyzing…' : 'Start Tracking'}
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

      {historicalBackfillUi &&
      !trackingOnboarding &&
      !(pipeline && pipeline.mailboxId === historicalBackfillUi.employeeId) ? (
        <div
          className="mb-4 rounded-xl border border-violet-200 bg-violet-50/70 px-4 py-3 text-sm text-violet-950 shadow-sm"
          aria-live="polite"
        >
          <p className="font-semibold text-violet-950">Backfilling your tracking window</p>
          <HistoricalBackfillProgressBlock
            ui={historicalBackfillUi}
            windowLine={
              (() => {
                const iso = liveTrackingDateTimeToIso(liveTrackDate, liveTrackTime);
                return iso ? absoluteTime(iso) : null;
              })()
            }
            ceoPortalDetail={ceoMyEmailAiPortalDetail}
          />
        </div>
      ) : null}

      {loading ? (
        <PortalPageLoader variant="embedded" />
      ) : (
        <>
          {myEmailTab === 'ceo' ? (
            <div className="mb-6 space-y-4">
              <>
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/60 bg-white p-3 shadow-card">
                    <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {me?.role === 'CEO' ? 'CEO inbox' : 'Your inbox'}
                    </span>
                  </div>
                  <CeoLiveSyncStrip
                      mailboxes={ownMailboxes}
                      liveTrackDate={liveTrackDate}
                      liveTrackTime={liveTrackTime}
                      onLiveTrackDateChange={setLiveTrackDate}
                      onLiveTrackTimeChange={setLiveTrackTime}
                      onSyncNow={() => void runLiveIngestionNow()}
                      syncBusy={liveSyncBusy}
                      nextIngestionAtIso={liveIngestSchedule?.nextIngestionAt ?? null}
                      scheduleReady={liveIngestSchedule != null}
                      canManualSync={canRunMyMailboxSync}
                      recentManualSyncAtMs={liveSyncAwaitingTimestamp}
                    />
              </>
            </div>
          ) : null}

          {me.role === 'CEO' &&
          myEmailTab === 'ceo' &&
          historicalBackfillUi &&
          historicalBackfillUi.phase !== 'complete' &&
          historicalBackfillUi.phase !== 'error' ? (
            <p className="mb-3 text-center text-xs font-medium text-violet-800">
              Stat cards and follow-up tab counts refresh live while messages are saved and threads are recomputed —
              use the progress card for per-message AI decisions until then.
            </p>
          ) : null}

          {/* ── KPI strip — follow-up command center (scoped to tab) ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              {
                label: 'Need your reply',
                value: kpiNeedReplyCount,
                color: 'text-red-600',
                hint:
                  'Threads where you owe a reply (or SLA is missed). Low / noise is hidden here except missed SLA. “Will track” counts messages Inbox AI accepted during backfill, not threads.',
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
          {/* ── Mailboxes: CEO / Manager / Team are separate views (sidebar hash), not one scroll ── */}
          <section className="order-1">
            {myEmailTab === 'ceo' ? (
              <>
                <div className="mb-3">
                  <h2 className="text-lg font-bold text-slate-900">
                    {me.role === 'CEO' ? 'Your inbox (CEO)' : 'Your inbox'}
                  </h2>
                </div>

                {mailboxes.length === 0 && (
                  <div className="mb-4 rounded-2xl border border-brand-200/80 bg-gradient-to-br from-indigo-50/90 to-white p-6 shadow-card">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                      {me.role === 'CEO' ? 'Your inbox (CEO)' : 'Your inbox'}
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
                          the row matches{' '}
                          {me.role === 'CEO' ? 'your CEO email' : 'your work email'}.
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

                {isDepartmentManagerRole(me.role) && (
                  <div className="mt-6 rounded-2xl border border-slate-200/70 bg-slate-50/50 px-4 py-4 sm:px-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          Add another address to track
                        </p>
                        <p className="mt-0.5 text-xs text-slate-600">
                          Use any work or personal email you can sign in with via Google — not only your login address.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddPersonalMailbox((v) => {
                            const open = !v;
                            if (open) {
                              setAddName('');
                              setAddEmail('');
                            }
                            return open;
                          });
                        }}
                        className="shrink-0 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        {showAddPersonalMailbox ? 'Cancel' : '+ Add email'}
                      </button>
                    </div>
                    {showAddPersonalMailbox ? (
                      <div className="mt-4 flex max-w-lg flex-col gap-3">
                        <input
                          type="text"
                          value={addName}
                          onChange={(e) => setAddName(e.target.value)}
                          placeholder="Display name"
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                        />
                        <input
                          type="email"
                          value={addEmail}
                          onChange={(e) => setAddEmail(e.target.value)}
                          placeholder="Email address to track"
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                        />
                        <button
                          type="button"
                          disabled={adding || !addName.trim() || !addEmail.trim()}
                          onClick={() => void addMailbox()}
                          className="w-fit rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
                        >
                          {adding ? 'Adding…' : 'Add mailbox'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}

            {myEmailTab === 'manager' ? (
              <div
                id="manager-mailboxes"
                className="scroll-mt-24 rounded-2xl border border-slate-100 bg-slate-50/40 px-4 py-5 sm:px-6"
              >
                <h2 className="text-lg font-bold text-slate-900">Manager mailboxes</h2>
                {managerMailboxes.length > 1 ? (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Managers in view
                      </p>
                      {managerScopeMailboxIds.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setManagerScopeMailboxIds([])}
                          className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          Show all
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {managerMailboxes.map((m) => {
                        const selected = managerScopeMailboxIds.includes(m.id);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setManagerScopeMailboxIds((prev) =>
                                prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id],
                              )
                            }
                            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                              selected
                                ? 'bg-brand-600 text-white shadow-sm'
                                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {managerScopedMailboxes.map((mb) => (
                    <div key={mb.id} className="space-y-2">
                      <TrackedMailboxCard
                        mb={mb}
                        showConnectGmail={false}
                        onConnectGmail={() => void connectGmail(mb.id)}
                        onRemove={() => void removeMailbox(mb.id)}
                        onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                        removing={deletingId === mb.id}
                        togglePauseLoading={togglePauseLoadingId === mb.id}
                        hideReconnectWhenConnected={true}
                      />
                    </div>
                  ))}
                </div>
                {managerScopedMailboxes.length === 0 ? (
                  <p className="mt-3 text-center text-sm text-slate-500">
                    {managerMailboxes.length === 0
                      ? 'No manager inboxes yet.'
                      : 'No manager inbox matches this selection.'}
                  </p>
                ) : null}
              </div>
            ) : null}

            {myEmailTab === 'team' ? (
              <>
                <h2 className="mb-3 text-lg font-bold text-slate-900">Team mailboxes</h2>

                <div
                  id="team-mailboxes-ceo"
                  className="scroll-mt-24 rounded-2xl border border-slate-100 bg-white px-4 py-5 shadow-sm sm:px-6"
                >
                  {teamMailboxesOnly.length > 1 ? (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          Employees in view
                        </p>
                        {employeeScopeMailboxIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setEmployeeScopeMailboxIds([])}
                            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            Show all
                          </button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {teamMailboxesOnly.map((m) => {
                          const selected = employeeScopeMailboxIds.includes(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() =>
                                setEmployeeScopeMailboxIds((prev) =>
                                  prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id],
                                )
                              }
                              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                                selected
                                  ? 'bg-brand-600 text-white shadow-sm'
                                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {m.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {teamScopedMailboxes.map((mb) => (
                      <div key={mb.id} className="space-y-2">
                        <TrackedMailboxCard
                          mb={mb}
                          showConnectGmail={false}
                          onConnectGmail={() => void connectGmail(mb.id)}
                          onRemove={() => void removeMailbox(mb.id)}
                          onTogglePause={(paused) => void toggleTrackingPause(mb, paused)}
                          removing={deletingId === mb.id}
                          togglePauseLoading={togglePauseLoadingId === mb.id}
                          hideReconnectWhenConnected={true}
                        />
                      </div>
                    ))}
                  </div>
                  {teamScopedMailboxes.length === 0 ? (
                    <p className="mt-3 text-center text-sm text-slate-500">
                      {teamMailboxesOnly.length === 0 ? (
                        <>
                          No team mailboxes in this view yet. Add teammates on <strong>Employees</strong> or use{' '}
                          <strong>+ Add another mailbox</strong> above. Heads also appear under{' '}
                          <strong>Manager mail</strong> for their own inbox.
                        </>
                      ) : (
                        'No employee mailbox matches this selection.'
                      )}
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
          {/* ── Follow-ups: tabs + compact list + drawer ── */}
          <section className="order-2 rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-5">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Follow-ups</h2>
                {showFullInboxChrome && aiSkippedMailboxId ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Skipped count updated:{' '}
                    <span className="font-medium tabular-nums text-slate-700">
                      {aiSkippedCountSyncedAt
                        ? new Date(aiSkippedCountSyncedAt).toLocaleTimeString()
                        : '…'}
                    </span>
                  </p>
                ) : null}
              </div>
              <input
                type="search"
                placeholder={
                  mailTab === 'skipped'
                    ? 'Search subject, sender, reason…'
                    : 'Search subject, client, person, thread id…'
                }
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 sm:max-w-xs"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Follow-up views">
              {(
                [
                  [
                    'action',
                    'Need reply',
                    'Conversations waiting for your response.',
                  ],
                  [
                    'waiting',
                    'Waiting on them',
                    'Conversations where you already replied.',
                  ],
                  [
                    'cc',
                    "CC'd",
                    'Conversations where you were included for awareness.',
                  ],
                  [
                    'closed',
                    'Done',
                    'Conversations already handled.',
                  ],
                  [
                    'noise',
                    'Low priority',
                    'Conversations that do not need urgent attention.',
                  ],
                  ...([
                        [
                          'skipped',
                          'Skipped',
                          'Conversations AI could not confidently categorize.',
                        ],
                      ] as const),
                ] as const
              ).map(([id, label, title]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  title={title}
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
                  {id === 'closed' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({scopedStats.done})</span>
                  ) : null}
                  {id === 'noise' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({kpiLowNoiseTabCount})</span>
                  ) : null}
                  {id === 'skipped' ? (
                    <span className="ml-1.5 tabular-nums opacity-80">({aiSkippedTotal})</span>
                  ) : null}
                </button>
              ))}
            </div>
            <p className="mt-3 text-sm text-slate-600">{activeTabExplanation}</p>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              {mailTab !== 'skipped' && scopedPersonOptions.length > 1 ? (
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

            {searchFilteredTabRows.length > 0 && mailTab !== 'skipped' ? (
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

            {mailTab === 'skipped' ? (
              <div className="mt-6">
                {!skippedMailboxCandidates.some((m) => isMailboxGmailConnected(m)) ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6 text-center text-sm text-slate-600">
                    {myEmailTab === 'ceo'
                      ? 'Connect Gmail on your inbox card above to load skipped-message history.'
                      : 'Skipped mail history appears after at least one mailbox in this view has Gmail linked (owner connects on Employees or their login).'}
                  </div>
                ) : (
                  <SkippedMailsTabTable
                    mailboxes={skippedMailboxCandidates}
                    rows={searchFilteredSkippedRows}
                    unfilteredPageCount={aiSkippedRows.length}
                    aiSkippedMailboxId={aiSkippedMailboxId}
                    onMailboxChange={setAiSkippedMailboxId}
                    onRefresh={() => void loadAiSkippedMails()}
                    aiSkippedLoading={aiSkippedLoading}
                    aiSkippedTotal={aiSkippedTotal}
                    aiSkippedOffset={aiSkippedOffset}
                    setAiSkippedOffset={setAiSkippedOffset}
                    onClearSkip={(id) => void clearAiSkipEntry(id)}
                    aiSkippedClearingId={aiSkippedClearingId}
                    selectedIds={skippedSelectedIds}
                    onToggleSelect={(id) =>
                      setSkippedSelectedIds((prev) => {
                        const n = new Set(prev);
                        if (n.has(id)) n.delete(id);
                        else n.add(id);
                        return n;
                      })
                    }
                    onSelectAllVisible={toggleSelectAllSkippedFiltered}
                    onBulkClearSkip={() => void clearSelectedSkippedSkips()}
                    skippedBulkClearing={skippedBulkClearing}
                  />
                )}
              </div>
            ) : scopedConversations.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center text-sm text-slate-600">
                {scopeMailboxIds.size === 0
                  ? 'No mailboxes in this view yet. Use Connect my Gmail in the Your inbox section above.'
                  : mailboxesForInboxShortcuts.some((m) => isMailboxGmailConnected(m))
                    ? 'No conversations yet — sync will create threads from relevant mail.'
                    : myEmailTab === 'ceo'
                      ? 'Connect Gmail on your inbox card above to start.'
                      : 'No linked Gmail in this view yet. Each mailbox owner connects their own inbox (Employees or their portal); you cannot connect for them here.'}
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
                {me.role === 'CEO' && myEmailTab === 'manager' ? (
                  <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Manager mailbox rows are read-only here. Use <span className="font-semibold text-slate-800">Message</span>{' '}
                    to contact a manager.
                  </p>
                ) : null}
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
                        {me.role === 'CEO' && myEmailTab === 'manager' ? (
                          <th className="min-w-[7rem] px-3 py-3 text-right">Message</th>
                        ) : (
                          <>
                            <th className="px-3 py-3">Gmail</th>
                            <th className="min-w-[5rem] px-3 py-3 text-right">Resolve</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {pagedTabRows.map((c) => {
                        const sla = slaChipLabel(c);
                        return (
                          <tr
                            key={c.conversation_id}
                            className={
                              me.role === 'CEO' && myEmailTab === 'manager'
                                ? 'hover:bg-slate-50/90'
                                : 'cursor-pointer hover:bg-slate-50/90'
                            }
                            onClick={() => {
                              if (me.role === 'CEO' && myEmailTab === 'manager') return;
                              router.push(conversationReadPath(c.conversation_id, pathname));
                            }}
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
                            {me.role === 'CEO' && myEmailTab === 'manager' ? (
                              <td className="px-3 py-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                                <a
                                  href="/departments#team-members"
                                  className="inline-flex rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                                >
                                  Message
                                </a>
                              </td>
                            ) : (
                              <>
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
                              </>
                            )}
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
          </div>

        </>
      )}
    </AppShell>
  );
}

export default function MyEmailPage() {
  return (
    <Suspense fallback={<PortalPageLoader variant="fullscreen" />}>
      <MyEmailPageInner />
    </Suspense>
  );
}
