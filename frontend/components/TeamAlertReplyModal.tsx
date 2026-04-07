'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { buildManagerReplyMailto } from '@/lib/managerReplyMailto';

export type TeamAlertReplyParent = {
  id: string;
  body: string;
  created_at: string;
  from_manager_name: string | null;
  from_manager_email: string | null;
};

type Props = {
  open: boolean;
  parent: TeamAlertReplyParent | null;
  token: string;
  onClose: () => void;
  onSent: () => void;
};

export function TeamAlertReplyModal({ open, parent, token, onClose, onSent }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && parent) {
      setText('');
      setErr(null);
    }
  }, [open, parent?.id]);

  if (!open || !parent) return null;

  const replyParent = parent;
  const mailtoHref = buildManagerReplyMailto(replyParent.from_manager_email, replyParent.body);

  async function send() {
    const body = text.trim();
    if (!body) {
      setErr('Write a message first.');
      return;
    }
    setErr(null);
    setSending(true);
    try {
      const res = await apiFetch('/team-alerts/reply', token, {
        method: 'POST',
        body: JSON.stringify({ parentAlertId: replyParent.id, message: body }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr((j.message as string) || 'Could not send reply');
        return;
      }
      onSent();
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-alert-reply-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 id="team-alert-reply-title" className="text-base font-semibold text-slate-900">
          Reply to your manager
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Sent in this app — your manager sees it under <span className="font-medium">Conversations</span>.
        </p>

        <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2 text-sm text-slate-800">
          <p className="text-xs font-semibold text-amber-900">
            {replyParent.from_manager_name?.trim() || 'Manager'} · {new Date(replyParent.created_at).toLocaleString()}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">{replyParent.body}</p>
        </div>

        <label htmlFor="team-alert-reply-text" className="mt-4 block text-xs font-medium text-slate-600">
          Your message
        </label>
        <textarea
          id="team-alert-reply-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (e.shiftKey) return;
            e.preventDefault();
            if (!sending) void send();
          }}
          rows={4}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          placeholder="Type your reply… (Enter to send, Shift+Enter for new line)"
          disabled={sending}
        />

        {err ? <p className="mt-2 text-sm text-red-600">{err}</p> : null}

        {mailtoHref ? (
          <p className="mt-3 text-xs text-slate-500">
            Prefer email?{' '}
            <a href={mailtoHref} className="font-medium text-brand-700 underline hover:text-brand-800">
              Open in your mail app
            </a>
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose()}
            disabled={sending}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
