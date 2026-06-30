'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  GMAIL_OAUTH_COMPLETE_MSG,
  humanizeMailSyncError,
  type GmailOAuthCompletePayload,
  type MailOAuthProvider,
} from '@/lib/gmail-oauth';
import { oauthErrorMessage } from '@/lib/api';

/**
 * Gmail OAuth lands here in a **popup** after the backend callback.
 * Notifies the opener and closes — the main tab never lost its session.
 * If there is no opener (popup blocked → full redirect), send user to `next` with query params.
 */
function GmailOauthDoneInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);

  useEffect(() => {
    const nextRaw = searchParams.get('next');
    const next =
      nextRaw && nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/my-email';
    const connected = searchParams.get('connected') === '1';
    const employeeId = searchParams.get('employee_id');
    const oauthError = searchParams.get('oauth_error');
    const providerRaw = searchParams.get('provider');
    const provider: MailOAuthProvider | null =
      providerRaw === 'microsoft'
        ? 'microsoft'
        : providerRaw === 'zoho'
          ? 'zoho'
          : providerRaw === 'google'
            ? 'google'
            : null;

    if (typeof window === 'undefined') return;

    const payload: GmailOAuthCompletePayload = {
      type: GMAIL_OAUTH_COMPLETE_MSG,
      next,
      connected,
      employee_id: employeeId,
      provider,
      oauth_error: oauthError,
    };

    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(payload, window.location.origin);
      } catch {
        /* ignore */
      }
      window.close();
      return;
    }

    if (!connected && oauthError) {
      setFallbackMessage(
        humanizeMailSyncError(oauthErrorMessage(oauthError) ?? oauthError),
      );
      const t = window.setTimeout(() => {
        const q = new URLSearchParams();
        q.set('oauth_error', oauthError);
        if (provider) q.set('provider', provider);
        router.replace(`${next}?${q.toString()}`);
      }, 2800);
      return () => window.clearTimeout(t);
    }

    const q = new URLSearchParams();
    if (connected) q.set('connected', '1');
    if (employeeId) q.set('employee_id', employeeId);
    if (provider) q.set('provider', provider);
    if (oauthError) q.set('oauth_error', oauthError);
    const qs = q.toString();
    router.replace(qs ? `${next}?${qs}` : next);
  }, [router, searchParams]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-600">
      <p className="font-medium text-slate-800">
        {fallbackMessage ? 'Mail connection failed' : 'Finishing mail connection…'}
      </p>
      <p className="text-xs text-slate-500">
        {fallbackMessage ?? 'This window should close automatically.'}
      </p>
    </div>
  );
}

export default function GmailOauthDonePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500">
          Loading…
        </div>
      }
    >
      <GmailOauthDoneInner />
    </Suspense>
  );
}
