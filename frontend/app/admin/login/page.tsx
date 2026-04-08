'use client';

import { FormEvent, Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PasswordInput } from '@/components/PasswordInput';
import { apiFetch } from '@/lib/api';
import { createClient } from '@/lib/supabase/client';

const inputClass =
  'mt-1.5 w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

function AdminLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => {
    const raw = searchParams.get('next');
    if (!raw || !raw.startsWith('/')) return '/admin';
    if (raw.startsWith('//')) return '/admin';
    return raw;
  }, [searchParams]);

  const [email, setEmail] = useState('email@gmail.com');
  const [password, setPassword] = useState('Hello1234@');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled || !session) return;
        const meRes = await apiFetch('/platform-admin/me', session.access_token);
        if (cancelled) return;
        if (meRes.ok) {
          const body = (await meRes.json().catch(() => ({}))) as { allowed?: boolean };
          if (body.allowed) {
            router.replace('/admin');
          }
        }
      } catch {
        // keep login form visible
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError(signInError.message || 'Login failed');
        return;
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setError('Could not create session. Try again.');
        return;
      }
      const meRes = await apiFetch('/platform-admin/me', session.access_token);
      if (!meRes.ok) {
        setError('Could not verify admin access.');
        return;
      }
      const meBody = (await meRes.json().catch(() => ({}))) as { allowed?: boolean };
      if (!meBody.allowed) {
        setError('This account does not have platform admin access.');
        return;
      }
      router.replace(nextPath.startsWith('/admin') ? nextPath : '/admin');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50 px-6 py-12">
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-8 shadow-[0_10px_40px_rgba(0,0,0,0.08)]">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Admin section</h1>
        <p className="mt-1 text-sm text-gray-500">Sign in as platform administrator.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-gray-700">
            Admin email
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Password
            <PasswordInput
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 py-3 font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading ? 'Signing in…' : 'Log in to admin'}
          </button>
        </form>

        {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
        <p className="mt-4 text-xs text-gray-500">
          Need normal workspace login? <Link href="/auth" className="text-indigo-600 hover:underline">Go to auth</Link>
        </p>
      </div>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50 px-6 py-12" />}>
      <AdminLoginInner />
    </Suspense>
  );
}
