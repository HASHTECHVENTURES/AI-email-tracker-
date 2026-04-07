'use client';

import Link from 'next/link';

export type TrackedMailbox = {
  id: string;
  name: string;
  email: string;
  gmail_connected?: boolean;
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
};

type TrackedMailboxCardProps = {
  mb: TrackedMailbox;
  ceoEmailNorm: string;
  trackingValue: string;
  slaValue: string;
  onTrackingChange: (value: string) => void;
  onSlaChange: (value: string) => void;
  onSaveTrackingStart: () => void;
  onSaveSla: () => void;
  onConnectGmail: () => void;
  onRemove: () => void;
  trackingSaving: boolean;
  slaSaving: boolean;
  removing: boolean;
  relativeTime: (iso: string | null | undefined) => string;
  absoluteTime: (iso: string | null | undefined) => string;
};

export function TrackedMailboxCard({
  mb,
  ceoEmailNorm,
  trackingValue,
  slaValue,
  onTrackingChange,
  onSlaChange,
  onSaveTrackingStart,
  onSaveSla,
  onConnectGmail,
  onRemove,
  trackingSaving,
  slaSaving,
  removing,
  relativeTime,
  absoluteTime,
}: TrackedMailboxCardProps) {
  const isCeoOwn = mb.email.trim().toLowerCase() === ceoEmailNorm;

  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card hover:-translate-y-[1px] hover:shadow-card-hover">
      <p className="truncate text-sm font-bold text-slate-900">{mb.name}</p>
      <p className="truncate text-xs text-slate-500">{mb.email}</p>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${mb.gmail_connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
        />
        <span className="text-xs text-slate-600">
          {mb.gmail_connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <dl className="mt-3 space-y-2.5 rounded-xl border border-slate-100 bg-slate-50/90 px-3 py-2.5 text-xs">
        <div className="flex gap-3 sm:gap-4">
          <dt className="w-28 shrink-0 text-slate-500">Last inbox sync</dt>
          <dd
            className="min-w-0 flex-1 text-right font-medium leading-snug text-slate-800"
            title={mb.last_synced_at ? absoluteTime(mb.last_synced_at) : undefined}
          >
            {mb.last_synced_at ? (
              <>
                {relativeTime(mb.last_synced_at)}
                <span className="mt-0.5 block font-normal text-[11px] text-slate-500">
                  {absoluteTime(mb.last_synced_at)}
                </span>
              </>
            ) : (
              <span className="font-normal text-slate-600">
                Not yet — appears after the first inbox crawl completes.
              </span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-2 border-t border-slate-100/80 pt-2.5 sm:flex-row sm:gap-4">
          <dt className="w-28 shrink-0 text-slate-500">Tracking since</dt>
          <dd className="min-w-0 flex-1 sm:text-right">
            <div className="flex flex-col gap-2 sm:ml-auto sm:max-w-xs">
              <input
                type="datetime-local"
                step={60}
                id={`tracking-${mb.id}`}
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={trackingValue}
                onChange={(e) => onTrackingChange(e.target.value)}
              />
              <button
                type="button"
                onClick={onSaveTrackingStart}
                disabled={trackingSaving}
                className="self-end rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:shadow-sm disabled:opacity-50"
              >
                {trackingSaving ? 'Saving…' : 'Save tracking start'}
              </button>
            </div>
            <p className="mt-2 text-left text-[10px] leading-relaxed text-slate-400 sm:text-right">
              Follow-up timing only includes mail on or after this moment. Opening threads is done in
              the{' '}
              <span className="font-medium text-slate-600">All conversations</span> section below.
            </p>
          </dd>
        </div>
      </dl>

      <div className="mt-3 rounded-xl border border-slate-100 bg-white px-3 py-2.5">
        <p className="text-xs font-medium text-slate-700">
          {isCeoOwn
            ? 'Your inbox — how long before a reply counts as overdue'
            : `${mb.name} — response-time target`}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`sla-${mb.id}`}>
            Hours to respond (SLA)
          </label>
          <input
            id={`sla-${mb.id}`}
            type="number"
            min={1}
            max={168}
            step={1}
            className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={slaValue}
            onChange={(e) => onSlaChange(e.target.value)}
          />
          <span className="text-xs text-slate-500">hours</span>
          <button
            type="button"
            onClick={onSaveSla}
            disabled={slaSaving}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 hover:shadow-sm disabled:opacity-50"
          >
            {slaSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          {isCeoOwn ? (
            <>
              Used for overdue timing vs SLA in the conversation tables below. To open mail, use{' '}
              <strong className="font-medium text-slate-700">View in Gmail</strong> on each row there —
              not here. Company-wide default for new mailboxes is in{' '}
              <Link
                href="/settings"
                className="font-medium text-brand-600 underline decoration-brand-600/30 underline-offset-2 hover:decoration-brand-600"
              >
                Settings
              </Link>
              .
            </>
          ) : (
            <>
              Used for overdue timing in the tables below;{' '}
              <strong className="font-medium text-slate-700">View in Gmail</strong> for each thread is
              below. Company default in{' '}
              <Link
                href="/settings"
                className="font-medium text-brand-600 underline decoration-brand-600/30 underline-offset-2 hover:decoration-brand-600"
              >
                Settings
              </Link>
              .
            </>
          )}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={onConnectGmail}
          className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-95 hover:shadow-md"
        >
          {mb.gmail_connected ? 'Reconnect' : 'Connect Gmail'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 hover:shadow-sm disabled:opacity-50"
        >
          {removing ? 'Removing...' : 'Remove'}
        </button>
      </div>
    </div>
  );
}
