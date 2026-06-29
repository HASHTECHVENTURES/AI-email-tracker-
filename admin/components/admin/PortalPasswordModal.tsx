'use client';

import { useState } from 'react';
import { PasswordInput } from '@/components/PasswordInput';
import { apiFetch, readApiErrorMessage } from '@/lib/api';
import {
  copyCredentialsToClipboard,
  downloadCredentialsTextFile,
  openCredentialsPrintWindow,
  portalLoginUrl,
  portalRoleLabel,
  type PortalCredentialPayload,
} from '@/lib/portal-credentials-document';

export type PortalPasswordTarget =
  | { kind: 'user'; userId: string; email: string; name: string; role: string }
  | { kind: 'employee'; employeeId: string; email: string; name: string; hasLogin: boolean; departmentName?: string | null };

type PortalPasswordModalProps = {
  companyId: string;
  companyName?: string | null;
  target: PortalPasswordTarget;
  token: string;
  onClose: () => void;
  onSaved: (message: string) => void;
};

function CredentialsPanel({
  payload,
  onDone,
}: {
  payload: PortalCredentialPayload;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyCredentialsToClipboard(payload);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  }

  return (
    <>
      <h3 className="text-lg font-semibold text-slate-900">
        {payload.isNewLogin ? 'Download login credentials' : 'Download updated credentials'}
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        {payload.fullName} · <span className="font-medium">{payload.email}</span>
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Download or copy this sheet and share it securely. The password is only shown here right after you set it.
      </p>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <dl className="space-y-2">
          {payload.companyName?.trim() ? (
            <div className="flex gap-3">
              <dt className="w-28 shrink-0 text-slate-500">Company</dt>
              <dd className="font-medium text-slate-900">{payload.companyName}</dd>
            </div>
          ) : null}
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-slate-500">Portal</dt>
            <dd className="font-medium text-slate-900">{portalRoleLabel(payload.role)}</dd>
          </div>
          {payload.departmentName?.trim() ? (
            <div className="flex gap-3">
              <dt className="w-28 shrink-0 text-slate-500">Department</dt>
              <dd className="font-medium text-slate-900">{payload.departmentName}</dd>
            </div>
          ) : null}
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-slate-500">Login URL</dt>
            <dd className="break-all font-medium text-slate-900">{portalLoginUrl()}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-slate-500">Email</dt>
            <dd className="break-all font-medium text-slate-900">{payload.email}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-slate-500">Password</dt>
            <dd className="break-all font-mono font-medium text-slate-900">{payload.password}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => openCredentialsPrintWindow(payload)}
          className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
        >
          Save as PDF
        </button>
        <button
          type="button"
          onClick={() => downloadCredentialsTextFile(payload)}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Download .txt
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Save as PDF opens a printable page — choose &quot;Save as PDF&quot; in the print dialog.
      </p>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Done
        </button>
      </div>
    </>
  );
}

export function PortalPasswordModal({
  companyId,
  companyName,
  target,
  token,
  onClose,
  onSaved,
}: PortalPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<PortalCredentialPayload | null>(null);

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
      const isNewLogin = body.action === 'login_created' || isCreate;
      const msg =
        isNewLogin
          ? `Portal login created for ${target.name}.`
          : `Password updated for ${target.name}.`;
      onSaved(msg);
      setCredentials({
        fullName: target.name,
        email: target.email,
        password,
        role: target.kind === 'user' ? target.role : 'EMPLOYEE',
        companyName,
        departmentName: target.kind === 'employee' ? target.departmentName : null,
        isNewLogin,
      });
      setPassword('');
      setConfirm('');
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
        {credentials ? (
          <CredentialsPanel
            payload={credentials}
            onDone={onClose}
          />
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
