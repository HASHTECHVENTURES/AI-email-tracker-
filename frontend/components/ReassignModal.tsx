'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';

export type EmployeeOption = { id: string; name: string };

type Props = {
  conversationId: string;
  clientEmail: string | null;
  currentEmployeeName: string;
  employees: EmployeeOption[];
  onClose: () => void;
  onSuccess: (newConversationId: string) => void;
};

export function ReassignModal({
  conversationId,
  clientEmail,
  currentEmployeeName,
  employees,
  onClose,
  onSuccess,
}: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const options = employees.filter((e) => e.name !== currentEmployeeName);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setError(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const res = await apiFetch(
        `/conversations/${encodeURIComponent(conversationId)}/reassign`,
        session.access_token,
        {
          method: 'POST',
          body: JSON.stringify({ targetEmployeeId: selectedId }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { newConversationId?: string; message?: string };
      if (!res.ok) {
        setError(body.message ?? 'Could not reassign conversation');
        return;
      }
      onSuccess(body.newConversationId ?? '');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reassign-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(ev) => {
        if (ev.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200/70 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5">
          <h2 id="reassign-title" className="text-lg font-bold text-slate-900">
            Reassign conversation
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Thread with <span className="font-medium text-slate-700">{clientEmail ?? '—'}</span>
          </p>
        </div>

        <div className="mb-4 rounded-xl border border-slate-100 bg-surface-muted/70 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Currently assigned</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">{currentEmployeeName}</p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}

          <div>
            <label htmlFor="reassign-emp" className="mb-1.5 block text-sm font-medium text-slate-700">
              Assign to
            </label>
            {options.length === 0 ? (
              <p className="text-sm text-slate-500">No other team members available.</p>
            ) : (
              <select
                id="reassign-emp"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select a team member…</option>
                {options.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="submit"
              disabled={loading || !selectedId || options.length === 0}
              className="rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
            >
              {loading ? 'Reassigning…' : 'Confirm reassign'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
