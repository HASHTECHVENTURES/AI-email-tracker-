'use client';

export type TrackedMailbox = {
  id: string;
  name: string;
  email: string;
  gmail_connected?: boolean;
  last_synced_at?: string | null;
  sla_hours_default?: number | null;
  tracking_start_at?: string | null;
  tracking_paused?: boolean;
};

type TrackedMailboxCardProps = {
  mb: TrackedMailbox;
  ceoEmailNorm: string;
  onConnectGmail: () => void;
  onRemove: () => void;
  onTogglePause?: (paused: boolean) => void;
  removing: boolean;
  togglePauseLoading?: boolean;
};

export function TrackedMailboxCard({
  mb,
  onConnectGmail,
  onRemove,
  onTogglePause,
  removing,
  togglePauseLoading = false,
}: TrackedMailboxCardProps) {
  const isOn = mb.tracking_paused !== true && mb.gmail_connected === true;

  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card hover:-translate-y-[1px] hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{mb.name}</p>
          <p className="truncate text-xs text-slate-500">{mb.email}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${mb.gmail_connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
          <span className="text-xs text-slate-600">
            {mb.gmail_connected ? 'Gmail connected' : 'Gmail not connected'}
          </span>
        </div>
        {mb.gmail_connected && onTogglePause ? (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${isOn ? 'text-emerald-700' : 'text-slate-500'}`}>
              {isOn ? 'ON' : 'OFF'}
            </span>
            <button
              type="button"
              onClick={() => onTogglePause(!isOn)}
              disabled={togglePauseLoading}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 disabled:opacity-50 ${
                isOn ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
              role="switch"
              aria-checked={isOn}
              aria-label={isOn ? 'Turn tracking off' : 'Turn tracking on'}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  isOn ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
