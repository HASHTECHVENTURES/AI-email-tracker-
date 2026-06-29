'use client';

import { useEffect, useState } from 'react';
import { apiFetch, readApiErrorMessage } from '@/lib/api';

type ProfileNameEditorProps = {
  token: string | null;
  displayName: string;
  onSaved: (fullName: string) => void;
  compact?: boolean;
};

export function ProfileNameEditor({
  token,
  displayName,
  onSaved,
  compact = false,
}: ProfileNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(displayName);
  }, [displayName, editing]);

  async function save() {
    if (!token) return;
    const next = draft.trim();
    if (!next) {
      setError('Enter your name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/auth/profile', token, {
        method: 'PATCH',
        body: JSON.stringify({ full_name: next }),
      });
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, 'Could not update your name.'));
      }
      const data = (await res.json()) as { user?: { full_name?: string | null } };
      const saved = data.user?.full_name?.trim() || next;
      onSaved(saved);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your name.');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={120}
          autoFocus
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          placeholder="Your name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              setEditing(false);
              setDraft(displayName);
              setError(null);
            }
          }}
        />
        {error ? <p className="text-[11px] text-red-600">{error}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-lg bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setDraft(displayName);
              setError(null);
            }}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? 'flex min-w-0 flex-wrap items-center gap-1' : 'space-y-1'}>
      <p
        className={
          compact
            ? 'truncate text-sm font-bold text-slate-900'
            : 'truncate text-sm font-bold text-slate-900'
        }
        title={displayName}
      >
        {displayName}
      </p>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={
          compact
            ? 'shrink-0 text-[11px] font-semibold text-brand-600 hover:text-brand-700 hover:underline'
            : 'text-left text-[11px] font-semibold text-brand-600 hover:text-brand-700 hover:underline'
        }
      >
        Change name
      </button>
    </div>
  );
}
