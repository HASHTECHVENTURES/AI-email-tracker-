'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';

const PENDING_KEY = 'pendingSignup';
const ROLE_KEY = 'selectedPortalRole';
type PortalRole = 'ceo' | 'manager' | 'employee';
type PendingSignup = {
  full_name: string;
  company_name: string;
  email?: string;
};

function AuthPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const finishMode = searchParams.get('finish') === '1';
  const err = searchParams.get('error');
  const errCode = searchParams.get('error_code');
  const errDescription = searchParams.get('error_description');
  const roleParam = (searchParams.get('portal') ?? '').toLowerCase();
  const selectedRole: PortalRole =
    roleParam === 'manager' || roleParam === 'employee' ? roleParam : 'ceo';

  const friendlyAuthError = (() => {
    const code = (errCode ?? '').toLowerCase();
    const raw = decodeURIComponent((errDescription ?? '').replace(/\+/g, ' '));
    if (code === 'otp_expired' || raw.toLowerCase().includes('expired')) {
      return 'Your sign-in link has expired. Please request a new one and try again.';
    }
    if ((err ?? '').toLowerCase() === 'missing_code') {
      return 'This sign-in link is invalid or incomplete. Please request a new one.';
    }
    if (raw) return `Auth error: ${raw}`;
    if (err) return `Auth error: ${err}`;
    return null;
  })();

  const [mode, setMode] = useState<'signup' | 'login'>(finishMode ? 'signup' : 'login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(friendlyAuthError);
  const [pendingSignupEmail, setPendingSignupEmail] = useState<string | null>(null);

  const matchesSelectedPortal = (portal: PortalRole, actualRole: string | null | undefined): boolean => {
    if (!actualRole) return false;
    const normalized = actualRole.toUpperCase();
    if (portal === 'ceo') return normalized === 'CEO';
    if (portal === 'manager') return normalized === 'HEAD' || normalized === 'MANAGER';
    return normalized === 'EMPLOYEE';
  };

  const expectedPortalLabel = (portal: PortalRole): string =>
    portal === 'ceo' ? 'CEO' : portal === 'manager' ? 'Manager' : 'Employee';

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

  useEffect(() => {
    sessionStorage.setItem(ROLE_KEY, selectedRole);
  }, [selectedRole]);

  useEffect(() => {
    const pending = readPendingSignup();
    if (!pending) return;
    if (!fullName) setFullName(pending.full_name);
    if (!companyName) setCompanyName(pending.company_name);
    if (pending.email) setPendingSignupEmail(pending.email);
  }, [fullName, companyName]);

  useEffect(() => {
    if (!finishMode) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        router.replace('/auth');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [finishMode, router]);

  useEffect(() => {
    if (finishMode) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled || !session) return;
      const statusRes = await apiFetch('/auth/status', session.access_token);
      const status = await statusRes.json();
      if (cancelled) return;
      const actualRole = status?.user?.role as string | undefined;
      if (!matchesSelectedPortal(selectedRole, actualRole)) {
        await supabase.auth.signOut();
        setInfo(
          `This account is ${actualRole ?? 'unknown role'}. Please log in from the ${expectedPortalLabel(selectedRole)} portal with the correct account.`,
        );
        return;
      }
      if (status.needs_onboarding) {
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
            localStorage.removeItem(PENDING_KEY);
            sessionStorage.removeItem(PENDING_KEY);
            router.replace('/dashboard');
            return;
          }
        }
        router.replace('/auth?finish=1');
        return;
      }
      router.replace('/dashboard');
    })();
    return () => {
      cancelled = true;
    };
  }, [finishMode, router, selectedRole]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const trimmedEmail = email.trim();

      if (mode === 'signup') {
        if (!fullName.trim() || !trimmedEmail || !companyName.trim() || !password) {
          setInfo('Please fill in all fields.');
          setLoading(false);
          return;
        }
        if (password.length < 8) {
          setInfo('Password must be at least 8 characters.');
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setInfo('Passwords do not match.');
          setLoading(false);
          return;
        }
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            full_name: fullName.trim(),
            company_name: companyName.trim(),
            email: trimmedEmail,
          }),
        );
        localStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            full_name: fullName.trim(),
            company_name: companyName.trim(),
            email: trimmedEmail,
          }),
        );
        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: {
            data: { full_name: fullName.trim(), company_name: companyName.trim() },
          },
        });
        if (error) {
          setInfo(error.message);
          return;
        }
        if (data.session) {
          router.replace('/auth?finish=1');
          return;
        }
        setInfo('Account created. Verify your email, then log in with your password.');
        return;
      }

      if (!trimmedEmail || !password) {
        setInfo('Email and password are required.');
        setLoading(false);
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
        setInfo('Session not found after login. Please try again.');
        return;
      }
      const statusRes = await apiFetch('/auth/status', session.access_token);
      const status = await statusRes.json().catch(() => ({}));
      const actualRole = (status as { user?: { role?: string } })?.user?.role;
      if (!matchesSelectedPortal(selectedRole, actualRole)) {
        await supabase.auth.signOut();
        setInfo(
          `This account is ${actualRole ?? 'unknown role'}. Please use the ${expectedPortalLabel(selectedRole)} portal.`,
        );
        return;
      }
      router.replace('/dashboard');
    } finally {
      setLoading(false);
    }
  };

  const finishOnboarding = async (e: React.FormEvent) => {
    e.preventDefault();
    setInfo(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setInfo('Session expired. Please log in again.');
        return;
      }
      if (!fullName.trim() || !companyName.trim()) {
        setInfo('Name and company are required.');
        return;
      }
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({
          full_name: fullName.trim(),
          company_name: companyName.trim(),
          email: email.trim() || pendingSignupEmail || undefined,
        }),
      );
      localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({
          full_name: fullName.trim(),
          company_name: companyName.trim(),
          email: email.trim() || pendingSignupEmail || undefined,
        }),
      );
      const res = await apiFetch('/auth/onboarding', session.access_token, {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName.trim(),
          company_name: companyName.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInfo(typeof body.message === 'string' ? body.message : 'Onboarding failed.');
        return;
      }
      localStorage.removeItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
      router.replace('/dashboard');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <aside className="hidden bg-gradient-to-br from-[#0f172a] to-[#020617] p-12 text-white lg:flex lg:flex-col lg:justify-center">
        <div className="max-w-md">
          <p className="mb-4 text-sm tracking-[0.12em] text-gray-400">MULTI-TENANT WORKSPACE</p>
          <h1 className="mb-4 text-4xl font-bold leading-tight">One login for every role.</h1>
          <p className="text-gray-400">
            Sign up once with your company, become CEO automatically, and invite your team later.
            Secure role-based access with email and password.
          </p>
        </div>
      </aside>

      <main className="flex items-center justify-center bg-white px-4 py-10 sm:px-6">
        <div className="w-full max-w-md px-0 sm:px-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm transition-all duration-200 hover:shadow-md">
          {finishMode ? (
            <>
              <h2 className="mb-2 text-2xl font-semibold text-gray-900">Finish setup</h2>
              <p className="mb-6 text-sm text-gray-500">
                Create your company profile. You will be assigned the CEO role.
              </p>
              <form onSubmit={finishOnboarding} className="space-y-4">
                <label className="block text-sm text-gray-700">
                  Full name
                  <input
                    required
                    value={fullName}
                    onChange={(ev) => setFullName(ev.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                    autoComplete="name"
                  />
                </label>
                <label className="block text-sm text-gray-700">
                  Company name
                  <input
                    required
                    value={companyName}
                    onChange={(ev) => setCompanyName(ev.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                    autoComplete="organization"
                  />
                </label>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading ? 'Saving…' : 'Create workspace'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-6 flex gap-2 rounded-lg bg-gray-100 p-1">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    mode === 'login' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Log in
                </button>
                <button
                  type="button"
                  onClick={() => setMode('signup')}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    mode === 'signup' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Sign up
                </button>
              </div>

              <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                Portal role: <span className="font-semibold uppercase">{selectedRole}</span>
              </div>
              {mode === 'login' && pendingSignupEmail && (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Email verification pending for{' '}
                  <span className="font-semibold">{pendingSignupEmail}</span>. Verify your email
                  first, then log in.
                </div>
              )}
              {mode === 'login' && /not confirmed|email.*confirm/i.test(info ?? '') && (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Your email is not verified yet. Open your inbox/spam and click the verification
                  link, then return to log in.
                </div>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-4">
                {mode === 'signup' && (
                  <>
                    <label className="block text-sm text-gray-700">
                      Full name
                      <input
                        required
                        value={fullName}
                        onChange={(ev) => setFullName(ev.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                        autoComplete="name"
                      />
                    </label>
                    <label className="block text-sm text-gray-700">
                      Company name
                      <input
                        required
                        value={companyName}
                        onChange={(ev) => setCompanyName(ev.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                        autoComplete="organization"
                      />
                    </label>
                  </>
                )}
                <label className="block text-sm text-gray-700">
                  Email
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(ev) => setEmail(ev.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                    autoComplete="email"
                  />
                </label>
                <label className="block text-sm text-gray-700">
                  Password
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  />
                </label>
                {mode === 'signup' && (
                  <label className="block text-sm text-gray-700">
                    Confirm password
                    <input
                      required
                      type="password"
                      value={confirmPassword}
                      onChange={(ev) => setConfirmPassword(ev.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500"
                      autoComplete="new-password"
                    />
                  </label>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading
                    ? mode === 'signup'
                      ? 'Creating account…'
                      : 'Logging in…'
                    : mode === 'signup'
                      ? 'Create account'
                      : 'Log in'}
                </button>
              </form>
              <p className="mt-4 text-center text-xs text-gray-500">
                Need a different role?{' '}
                <a href="/portal" className="font-medium text-blue-600 hover:text-blue-700">
                  Go to portal
                </a>
              </p>
            </>
          )}

          {info && (
            <p className="mt-4 text-sm text-gray-500" role="status">
              {info}
            </p>
          )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      }
    >
      <AuthPageInner />
    </Suspense>
  );
}
