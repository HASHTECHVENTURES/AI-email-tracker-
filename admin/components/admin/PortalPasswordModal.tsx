'use client';

import { useState } from 'react';
import { PasswordInput } from '@/components/PasswordInput';
import { apiFetch, readApiErrorMessage } from '@/lib/api';

export type PortalPasswordTarget =
  | { kind: 'user'; userId: string; email: string; name: string; role: string }
  | { kind: 'employee'; employeeId: string; email: string; name: string; hasLogin: boolean };

type PortalPasswordModalProps = {
  companyId: string;
  target: PortalPasswordTarget;
  token: string;
  onClose: () => void;
  onSaved: (message: string) => void;
};

export function PortalPasswordModal({
  companyId,
  target,
  token,
  onClose,
  onSaved,
}: PortalPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate =
    target.kind === 'employee' ? !target.hasLogin : false;
  const title =
    target.kind === 'user'
      ? 'Reset portal password'
      : isCreate
        ? 'Create portal login'
        : 'Reset portal password';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const path =
        target.kind === 'user'
          ? `/platform-admin/companies/${encodeURIComponent(companyId)}/users/${encodeURIComponent(target.userId)}/password`
          : `/platform-admin/companies/${encodeURIComponent(companyId)}/employees/${encodeURIComponent(target.employeeId)}/portal-password`;

      const res = await apiFetch(path, token, {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, 'Could not save password.'));
        return;
      }
      const body = (await res.json()) as { action?: string };
      const msg =
        body.action === 'login_created'
          ? `Portal login created for ${target.name}. Share the password securely.`
          : `Password updated for ${target.name}.`;
      onSaved(msg);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-sm text-slate-600">
          {target.name}
          {' · '}
          <span className="font-medium">{target.email}</span>
          {target.kind === 'user' ? (
            <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs uppercase text-slate-500">
              {target.role}
            </span>
          ) : null}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Minimum 8 characters. The user signs in with this email and the password you set.
        </p>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

        <form onSubmit={(e) => void onSubmit(e)} className="mt-4 space-y-3">
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <PasswordInput
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isCreate ? 'Create login' : 'Save password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
