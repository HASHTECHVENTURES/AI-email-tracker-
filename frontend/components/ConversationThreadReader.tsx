'use client';

import { useEffect, useState } from 'react';
import { apiFetch, readApiErrorMessage } from '@/lib/api';

export type ThreadMessageDto = {
  provider_message_id: string;
  subject: string;
  from_email: string;
  from_name: string | null;
  to_emails: string[];
  direction: string;
  body_text: string;
  sent_at: string;
};

type Props = {
  conversationId: string | null | undefined;
  token: string | null | undefined;
  /** Parent already fetched `GET /conversations/:id/messages` — skips a duplicate request. */
  messagesData?: ThreadMessageDto[] | null;
  /** Conversation row client — used to label messages from the main external contact vs other participants. */
  trackedClientEmail?: string | null;
  className?: string;
};

function normEmail(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

function formatFrom(m: ThreadMessageDto): string {
  const n = m.from_name?.trim();
  if (n) return `${n} <${m.from_email}>`;
  return m.from_email;
}

export function ConversationThreadReader({
  conversationId,
  token,
  messagesData,
  trackedClientEmail,
  className = '',
}: Props) {
  const [items, setItems] = useState<ThreadMessageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (messagesData !== undefined) {
      setItems(messagesData);
      setError(null);
      setLoading(false);
      return;
    }
    if (!conversationId?.trim() || !token) {
      setItems(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems(null);
    void (async () => {
      const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/messages`, token);
      if (cancelled) return;
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not load messages.'));
        setItems([]);
        setLoading(false);
        return;
      }
      const j = (await res.json()) as { messages?: ThreadMessageDto[] };
      setItems(Array.isArray(j.messages) ? j.messages : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, messagesData]);

  if (!conversationId?.trim() && messagesData === undefined) return null;

  const displayItems = messagesData !== undefined ? messagesData : items;
  const showFetchLoading = messagesData === undefined && loading;

  if (showFetchLoading) {
    return <p className={`text-sm text-slate-500 ${className}`}>Loading mail from your synced inbox…</p>;
  }

  if (error) {
    return <p className={`text-sm text-red-600 ${className}`}>{error}</p>;
  }

  if (!displayItems || displayItems.length === 0) {
    return (
      <p className={`text-sm text-slate-500 ${className}`}>
        No message bodies synced for this thread yet. Open Gmail if the thread is still pulling in.
      </p>
    );
  }

  const trackNorm = normEmail(trackedClientEmail);

  return (
    <div className={className}>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        Thread messages (plain text from Gmail)
      </p>
      <p className="mb-4 text-xs text-slate-500">
        Incoming = to the synced mailbox · Outgoing = sent from the mailbox. One Gmail thread = one conversation here.
      </p>
      <div className="space-y-5">
        {displayItems.map((m) => {
          const inbound = String(m.direction).toUpperCase() === 'INBOUND';
          const isMainClient =
            inbound &&
            trackNorm.length > 0 &&
            normEmail(m.from_email) === trackNorm;
          const shell = inbound
            ? 'border-sky-200 bg-sky-50/50 border-l-4 border-l-sky-500'
            : 'border-violet-200 bg-violet-50/40 border-l-4 border-l-violet-600';

          return (
            <article
              key={m.provider_message_id}
              className={`rounded-xl border px-4 py-3 shadow-sm ${shell}`}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-slate-200/80 pb-3">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    inbound ? 'bg-sky-600 text-white' : 'bg-violet-700 text-white'
                  }`}
                >
                  {inbound ? 'Incoming' : 'Outgoing'}
                </span>
                {isMainClient ? (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-900 ring-1 ring-emerald-200">
                    Tracked client
                  </span>
                ) : null}
              </div>
              <header className="mb-3 space-y-1 text-xs text-slate-600">
                <p className="text-sm font-semibold text-slate-900">{m.subject?.trim() || '(no subject)'}</p>
                <p>
                  <span className="font-medium text-slate-400">From</span> {formatFrom(m)}
                </p>
                <p>
                  <span className="font-medium text-slate-400">To</span>{' '}
                  {(m.to_emails ?? []).length ? (m.to_emails ?? []).join(', ') : '—'}
                </p>
                <p>
                  <span className="font-medium text-slate-400">Sent</span>{' '}
                  {new Date(m.sent_at).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </p>
              </header>
              <div
                className="max-h-[min(70vh,48rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200/80 bg-white/90 px-3 py-3 font-sans text-sm leading-relaxed text-slate-800"
                data-testid="thread-message-body"
              >
                {m.body_text?.trim() ? m.body_text : <span className="text-slate-400 italic">(No body text in sync)</span>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
