'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';

const PENDING_KEY = 'pendingSignup';

export default function AuthCompletePage() {
  const router = useRouter();
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/auth');
        return;
      }

      const token = session.access_token;
      const statusRes = await apiFetch('/auth/status', token);
      const status = await statusRes.json();

      if (cancelled) return;

      if (!status.needs_onboarding && status.user) {
        router.replace('/dashboard');
        return;
      }

      let fullName = '';
      let companyName = '';
      try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { full_name?: string; company_name?: string };
          fullName = parsed.full_name?.trim() ?? '';
          companyName = parsed.company_name?.trim() ?? '';
        }
      } catch {
        /* ignore */
      }

      if (!fullName || !companyName) {
        setMessage('Almost there — we need your name and company to finish setup.');
        router.replace('/auth?finish=1');
        return;
      }

      const onboard = await apiFetch('/auth/onboarding', token, {
        method: 'POST',
        body: JSON.stringify({ full_name: fullName, company_name: companyName }),
      });

      if (!onboard.ok) {
        const err = await onboard.json().catch(() => ({}));
        setMessage(typeof err.message === 'string' ? err.message : 'Could not complete signup.');
        return;
      }

      sessionStorage.removeItem(PENDING_KEY);
      router.replace('/dashboard');
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <p style={{ color: 'var(--muted)' }}>{message}</p>
    </div>
  );
}
