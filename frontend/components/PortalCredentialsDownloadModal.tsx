'use client';

import { useState } from 'react';
import {
  copyCredentialsToClipboard,
  downloadCredentialsPdfFile,
  downloadCredentialsTextFile,
  openCredentialsPrintWindow,
  portalLoginUrl,
  portalRoleLabel,
  type PortalCredentialPayload,
} from '@/lib/portal-credentials-document';

type PortalCredentialsDownloadModalProps = {
  payload: PortalCredentialPayload;
  onClose: () => void;
};

export function PortalCredentialsDownloadModal({
  payload,
  onClose,
}: PortalCredentialsDownloadModalProps) {
  const [copied, setCopied] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  async function handleSavePdf() {
    setPdfError(null);
    setPdfBusy(true);
    try {
      const ok = await downloadCredentialsPdfFile(payload);
      if (!ok) {
        const printed = openCredentialsPrintWindow(payload);
        if (!printed) {
          setPdfError('Could not download PDF. Try Download .txt or Copy instead.');
        }
      }
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleCopy() {
    const ok = await copyCredentialsToClipboard(payload);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  }

  const title = payload.isNewLogin ? 'Download login credentials' : 'Download updated credentials';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credentials-download-title"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h3 id="credentials-download-title" className="text-lg font-semibold text-slate-900">
          {title}
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          {payload.fullName} · <span className="font-medium text-slate-800">{payload.email}</span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
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
            onClick={() => void handleSavePdf()}
            disabled={pdfBusy}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {pdfBusy ? 'Preparing PDF…' : 'Save as PDF'}
          </button>
          <button
            type="button"
            onClick={() => downloadCredentialsTextFile(payload)}
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Download .txt
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Save as PDF downloads a file named portal-credentials-…pdf to your computer.
        </p>
        {pdfError ? <p className="mt-2 text-xs text-red-600">{pdfError}</p> : null}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
