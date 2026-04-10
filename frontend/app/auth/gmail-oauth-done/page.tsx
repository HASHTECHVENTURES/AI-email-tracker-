'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GMAIL_OAUTH_COMPLETE_MSG, type GmailOAuthCompletePayload } from '@/lib/gmail-oauth';

/**
 * Gmail OAuth lands here in a **popup** after the backend callback.
 * Notifies the opener and closes — the main tab never lost its session.
 * If there is no opener (popup blocked → full redirect), send user to `next` with query params.
 */
function GmailOauthDoneInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const nextRaw = searchParams.get('next');
    const next =
      nextRaw && nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/my-email';
    const connected = searchParams.get('connected') === '1';
    const employeeId = searchParams.get('employee_id');

    if (typeof window === 'undefined') return;

    const payload: GmailOAuthCompletePayload = {
      type: GMAIL_OAUTH_COMPLETE_MSG,
      next,
      connected,
      employee_id: employeeId,
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

    const q = new URLSearchParams();
    if (connected) q.set('connected', '1');
    if (employeeId) q.set('employee_id', employeeId);
    const qs = q.toString();
    router.replace(qs ? `${next}?${qs}` : next);
  }, [router, searchParams]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-600">
      <p className="font-medium text-slate-800">Finishing Gmail connection…</p>
      <p className="text-xs text-slate-500">This window should close automatically.</p>
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
