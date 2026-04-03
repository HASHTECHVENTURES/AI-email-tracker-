'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const PENDING_KEY = 'pendingSignup';

type TabMode = 'login' | 'create';
type SignupRole = 'ceo' | 'manager' | 'employee';
type Phase = 'boot' | 'auth' | 'onboarding';

type PendingSignup = {
  full_name: string;
  company_name: string;
  email?: string;
};

const shellClass = 'min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50';
const inputClass =
  'w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const btnPrimaryClass =
  'w-full rounded-lg bg-indigo-600 py-3 font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70';
const cardClass =
  'w-full max-w-md rounded-2xl bg-white p-8 shadow-[0_10px_40px_rgba(0,0,0,0.08)]';

function BrandingPanel() {
  return (
    <aside className="hidden flex-col justify-center px-8 py-12 lg:flex lg:px-16">
      <h1 className="text-4xl font-semibold tracking-tight text-gray-900">Stay on top of every follow-up</h1>
      <p className="mt-4 max-w-md text-base leading-relaxed text-gray-500">
        Track conversations, never miss replies, and manage your team effortlessly.
      </p>
      <ul className="mt-8 space-y-2.5 text-sm text-gray-500">
        <li className="flex gap-2">
          <span className="text-indigo-400">•</span>
          <span>Know what needs attention</span>
        </li>
        <li className="flex gap-2">
          <span className="text-indigo-400">•</span>
          <span>Track performance</span>
        </li>
        <li className="flex gap-2">
          <span className="text-indigo-400">•</span>
          <span>AI-powered insights</span>
        </li>
      </ul>
    </aside>
  );
}

function RoleSegment({
  value,
  onChange,
}: {
  value: SignupRole;
  onChange: (r: SignupRole) => void;
}) {
  const roles: { id: SignupRole; label: string }[] = [
    { id: 'ceo', label: 'CEO' },
    { id: 'manager', label: 'Manager' },
    { id: 'employee', label: 'Employee' },
  ];
  return (
    <div className="mb-6">
      <p className="mb-2 text-sm font-medium text-gray-600">Continue as</p>
      <div className="flex rounded-full bg-gray-100 p-1">
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onChange(r.id)}
            className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
              value === r.id
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AuthPageInner() {
  const router = useRouter();
  const { me, loading: authCtxLoading, error: authCtxError, refreshMe } = useAuth();
  const searchParams = useSearchParams();
  const completeFromEmail = searchParams.get('complete') === '1';
  const err = searchParams.get('error');
  const errCode = searchParams.get('error_code');
  const errDescription = searchParams.get('error_description');
  const nextPathRaw = searchParams.get('next');
  const safeNext =
    nextPathRaw && nextPathRaw.startsWith('/') && !nextPathRaw.startsWith('//')
      ? nextPathRaw
      : '/dashboard';

  const friendlyAuthError = (() => {
    const code = (errCode ?? '').toLowerCase();
    let raw = '';
    try {
      raw = decodeURIComponent((errDescription ?? '').replace(/\+/g, ' '));
    } catch {
      raw = errDescription ?? '';
    }
    if (code === 'otp_expired' || raw.toLowerCase().includes('expired')) {
      return 'That link expired. Sign in again.';
    }
    if ((err ?? '').toLowerCase() === 'missing_code') {
      return 'That link is invalid. Try signing in again.';
    }
    if (raw) return raw;
    if (err) return err;
    return null;
  })();

  const [phase, setPhase] = useState<Phase>('boot');
  const [tab, setTab] = useState<TabMode>('login');
  const [signupRole, setSignupRole] = useState<SignupRole>('ceo');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(friendlyAuthError);
  const [pendingEmailHint, setPendingEmailHint] = useState<string | null>(null);

  const readPendingSignup = (): PendingSignup | null => {
    if (typeof window === 'undefined') return null;
    const raw =
      localStorage.getItem(PENDING_KEY) ?? sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingSignup;
      if (!parsed.full_name || !parsed.company_name) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const persistPending = (p: PendingSignup) => {
    const s = JSON.stringify(p);
    sessionStorage.setItem(PENDING_KEY, s);
    localStorage.setItem(PENDING_KEY, s);
  };

  const clearPending = () => {
    localStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
  };

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (authCtxLoading) return;

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session) {
        setPhase('auth');
        return;
      }

      if (authCtxError) {
        setInfo(authCtxError);
        setPhase('auth');
        return;
      }

      const token = session.access_token;
      const statusRes = await apiFetch('/auth/status', token);
      if (!statusRes.ok) {
        if (statusRes.status === 401) {
          await supabase.auth.signOut();
        }
        setPhase('auth');
        return;
      }
      const status = await statusRes.json();
      if (cancelled) return;

      if (!status.needs_onboarding && status.user) {
        if (!me) {
          return;
        }
        router.replace(safeNext);
        return;
      }

      if (completeFromEmail) {
        const pending = readPendingSignup();
        if (pending?.full_name && pending?.company_name) {
          const onboardRes = await apiFetch('/auth/onboarding', token, {
            method: 'POST',
            body: JSON.stringify({
              full_name: pending.full_name,
              company_name: pending.company_name,
            }),
          });
          if (cancelled) return;
          if (onboardRes.ok) {
            clearPending();
            router.replace(safeNext);
            return;
          }
        }
      }

      const pending = readPendingSignup();
      if (pending) {
        setFullName((prev) => prev || pending.full_name);
        setCompanyName((prev) => prev || pending.company_name);
        if (pending.email) {
          setPendingEmailHint((prev) => prev ?? pending.email ?? null);
        }
      }
      setPhase('onboarding');
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [authCtxLoading, authCtxError, me, router, safeNext, completeFromEmail]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) {
        setInfo('Email and password are required.');
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (error) {
        setInfo(error.message);
        return;
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setInfo('Could not start session. Try again.');
        return;
      }
      const statusRes = await apiFetch('/auth/status', session.access_token);
      const status = await statusRes.json().catch(() => ({}));
      if ((status as { needs_onboarding?: boolean }).needs_onboarding) {
        const pending = readPendingSignup();
        if (pending?.full_name && pending?.company_name) {
          const onboardRes = await apiFetch('/auth/onboarding', session.access_token, {
            method: 'POST',
            body: JSON.stringify({
              full_name: pending.full_name,
              company_name: pending.company_name,
            }),
          });
          if (onboardRes.ok) {
            clearPending();
            await refreshMe(session.access_token);
            router.replace(safeNext);
            return;
          }
        }
        setPhase('onboarding');
        return;
      }
      await refreshMe(session.access_token);
      router.replace(safeNext);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCeo = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const trimmedEmail = email.trim();
      const trimmedName = fullName.trim();
      const trimmedCo = companyName.trim();
      if (!trimmedName || !trimmedEmail || !trimmedCo || !password) {
        setInfo('Please fill in all fields.');
        return;
      }
      if (password.length < 8) {
        setInfo('Password must be at least 8 characters.');
        return;
      }
      persistPending({
        full_name: trimmedName,
        company_name: trimmedCo,
        email: trimmedEmail,
      });

      const { error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          data: { full_name: trimmedName, company_name: trimmedCo },
        },
      });
      if (error) {
        setInfo(error.message);
        return;
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        const onboardRes = await apiFetch('/auth/onboarding', session.access_token, {
          method: 'POST',
          body: JSON.stringify({
            full_name: trimmedName,
            company_name: trimmedCo,
          }),
        });
        if (onboardRes.ok) {
          clearPending();
          router.replace(safeNext);
          return;
        }
        const errBody = await onboardRes.json().catch(() => ({}));
        setInfo(
          typeof (errBody as { message?: string }).message === 'string'
            ? (errBody as { message: string }).message
            : 'Could not create workspace.',
        );
        return;
      }
      setInfo('Check your email to verify your account, then sign in.');
    } finally {
      setLoading(false);
    }
  };

  const handleOnboarding = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setInfo('Session expired. Sign in again.');
        setPhase('auth');
        return;
      }
      const trimmedName = fullName.trim();
      const trimmedCo = companyName.trim();
      if (!trimmedName || !trimmedCo) {
        setInfo('Name and company are required.');
        return;
      }
      persistPending({
        full_name: trimmedName,
        company_name: trimmedCo,
        email: email.trim() || pendingEmailHint || undefined,
      });
      const res = await apiFetch('/auth/onboarding', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          full_name: trimmedName,
          company_name: trimmedCo,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInfo(typeof body.message === 'string' ? body.message : 'Something went wrong.');
        return;
      }
      clearPending();
      router.replace(safeNext);
    } finally {
      setLoading(false);
    }
  };

  if (phase === 'boot') {
    return (
      <div className={`flex items-center justify-center px-6 ${shellClass}`}>
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (phase === 'onboarding') {
    return (
      <div className={`grid grid-cols-1 lg:grid-cols-2 ${shellClass}`}>
        <BrandingPanel />
        <main className="flex items-center justify-center px-6 py-12 lg:px-12">
          <div className={cardClass}>
            <h2 className="text-xl font-semibold text-gray-900">Finish setup</h2>
            <p className="mt-1 text-sm text-gray-500">Add your details to continue.</p>
            <form onSubmit={handleOnboarding} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-gray-700">
                Full name
                <input
                  required
                  value={fullName}
                  onChange={(ev) => setFullName(ev.target.value)}
                  className={`mt-1.5 ${inputClass}`}
                  autoComplete="name"
                />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Company name
                <input
                  required
                  value={companyName}
                  onChange={(ev) => setCompanyName(ev.target.value)}
                  className={`mt-1.5 ${inputClass}`}
                  autoComplete="organization"
                />
              </label>
              <button type="submit" disabled={loading} className={btnPrimaryClass}>
                {loading ? 'Saving…' : 'Continue'}
              </button>
            </form>
            {info ? (
              <p className="mt-4 text-sm text-gray-500" role="status">
                {info}
              </p>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-2 ${shellClass}`}>
      <BrandingPanel />
      <main className="flex items-center justify-center px-6 py-12 lg:px-12">
        <div className={cardClass}>
          <div className="mb-8 flex rounded-lg bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTab('login');
                setInfo(null);
              }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                tab === 'login' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Log in
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('create');
                setInfo(null);
              }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                tab === 'create' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Create account
            </button>
          </div>

          {tab === 'login' ? (
            <>
              <div className="mb-6">
                <h2 className="text-2xl font-semibold tracking-tight text-gray-900">Welcome back</h2>
                <p className="mt-1 text-sm text-gray-500">Sign in to your account</p>
              </div>
              <form onSubmit={handleLogin} className="space-y-4">
                <label className="block text-sm font-medium text-gray-700">
                  Email
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(ev) => setEmail(ev.target.value)}
                    className={`mt-1.5 ${inputClass}`}
                    autoComplete="email"
                  />
                </label>
                <label className="block text-sm font-medium text-gray-700">
                  Password
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    className={`mt-1.5 ${inputClass}`}
                    autoComplete="current-password"
                  />
                </label>
                <button type="submit" disabled={loading} className={btnPrimaryClass}>
                  {loading ? 'Signing in…' : 'Log in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <RoleSegment value={signupRole} onChange={setSignupRole} />
              {signupRole === 'ceo' ? (
                <>
                  <div className="mb-6">
                    <h2 className="text-2xl font-semibold tracking-tight text-gray-900">Create your workspace</h2>
                    <p className="mt-1 text-sm text-gray-500">Get started in seconds</p>
                  </div>
                  <form onSubmit={handleCreateCeo} className="space-y-4">
                    <label className="block text-sm font-medium text-gray-700">
                      Company name
                      <input
                        required
                        value={companyName}
                        onChange={(ev) => setCompanyName(ev.target.value)}
                        className={`mt-1.5 ${inputClass}`}
                        autoComplete="organization"
                      />
                    </label>
                    <label className="block text-sm font-medium text-gray-700">
                      Full name
                      <input
                        required
                        value={fullName}
                        onChange={(ev) => setFullName(ev.target.value)}
                        className={`mt-1.5 ${inputClass}`}
                        autoComplete="name"
                      />
                    </label>
                    <label className="block text-sm font-medium text-gray-700">
                      Email
                      <input
                        required
                        type="email"
                        value={email}
                        onChange={(ev) => setEmail(ev.target.value)}
                        className={`mt-1.5 ${inputClass}`}
                        autoComplete="email"
                      />
                    </label>
                    <label className="block text-sm font-medium text-gray-700">
                      Password
                      <input
                        required
                        type="password"
                        value={password}
                        onChange={(ev) => setPassword(ev.target.value)}
                        className={`mt-1.5 ${inputClass}`}
                        autoComplete="new-password"
                      />
                    </label>
                    <button type="submit" disabled={loading} className={btnPrimaryClass}>
                      {loading ? 'Creating…' : 'Create account'}
                    </button>
                  </form>
                </>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-gray-500">Ask your admin for an account, then sign in.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('login');
                      setInfo(null);
                    }}
                    className={btnPrimaryClass}
                  >
                    Go to log in
                  </button>
                </div>
              )}
            </>
          )}

          {info ? (
            <p className="mt-4 text-sm text-gray-500" role="status">
              {info}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className={`flex min-h-screen items-center justify-center px-6 ${shellClass}`}>
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      }
    >
      <AuthPageInner />
    </Suspense>
  );
}
