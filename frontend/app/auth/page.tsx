'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { PasswordInput } from '@/components/PasswordInput';

const PENDING_KEY = 'pendingSignup';

/** After Gmail OAuth, middleware may send users to /auth without a session; restore ?connected=1 post-login for my-email toast. */
const POST_AUTH_GMAIL_CONNECTED_KEY = 'ai_et_post_auth_gmail_connected_v1';

function rememberGmailConnectedFromUrl() {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(POST_AUTH_GMAIL_CONNECTED_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Append ?connected=1 once, then clear the session flag (used for post-login redirect). */
function consumeGmailConnectedRedirect(path: string, urlHadConnected: boolean): string {
  if (typeof window === 'undefined') return path;
  let attach = urlHadConnected;
  try {
    if (sessionStorage.getItem(POST_AUTH_GMAIL_CONNECTED_KEY) === '1') {
      attach = true;
      sessionStorage.removeItem(POST_AUTH_GMAIL_CONNECTED_KEY);
    }
  } catch {
    /* ignore */
  }
  if (!attach) return path;
  if (path.includes('connected=1')) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}connected=1`;
}

/** Shown on dashboard after redirect when onboarding finds an existing profile (duplicate signup). */
const AUTH_NOTICE_STORAGE_KEY = 'ai_et_auth_notice_v1';

const DUPLICATE_WORKSPACE_MSG =
  'A workspace is already set up for this email and company profile. You can continue with your existing account.';

function mapSupabaseSignUpError(message: string): string {
  if (/already registered|already been registered|user already registered|email address is already|exists/i.test(message)) {
    return 'An account with this email already exists. Use Log in, or reset your password if you forgot it.';
  }
  return message;
}

function writeAuthNoticeForDashboard(message: string) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(AUTH_NOTICE_STORAGE_KEY, JSON.stringify({ message }));
  } catch {
    /* ignore quota */
  }
}

/** Dev / staging shortcut: click the grid icon to fill login fields. Disable in production by not setting NEXT_PUBLIC_SHOW_AUTH_QUICK_FILL. */
const DEV_ADMIN_EMAIL = 'email@gmail.com';
const DEV_ADMIN_PASSWORD = 'Hello1234@';

function showAuthQuickFill(): boolean {
  if (typeof process.env.NEXT_PUBLIC_SHOW_AUTH_QUICK_FILL === 'string') {
    return process.env.NEXT_PUBLIC_SHOW_AUTH_QUICK_FILL === 'true';
  }
  return process.env.NODE_ENV === 'development';
}

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
  const hasExplicitNext = Boolean(
    nextPathRaw && nextPathRaw.startsWith('/') && !nextPathRaw.startsWith('//'),
  );
  const safeNext = hasExplicitNext ? (nextPathRaw as string) : '/dashboard';

  /** Platform operators default to /admin, not the CEO dashboard. */
  function postLoginPath(role: string | undefined, path: string): string {
    if (role === 'PLATFORM_ADMIN') {
      if (!hasExplicitNext || path === '/dashboard') return '/admin';
    }
    return path;
  }

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
  const [infoVariant, setInfoVariant] = useState<'default' | 'notice'>('default');
  const [pendingEmailHint, setPendingEmailHint] = useState<string | null>(null);
  const gmailConnectedParam = searchParams.get('connected') === '1';

  useEffect(() => {
    if (!gmailConnectedParam) return;
    rememberGmailConnectedFromUrl();
    if (!friendlyAuthError) {
      setInfoVariant('notice');
      setInfo(
        'Gmail is connected. Sign in below to return to your inbox — your session can expire while you finish the Google sign-in step.',
      );
    }
  }, [gmailConnectedParam, friendlyAuthError]);

  const clearFeedback = () => {
    setInfo(null);
    setInfoVariant('default');
  };

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

  const clearPending = useCallback(() => {
    localStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
  }, []);

  /** Platform operators must never enter tenant onboarding; send them directly to /admin. */
  const redirectIfPlatformAdmin = useCallback(
    async (accessToken: string): Promise<boolean> => {
      const res = await apiFetch('/platform-admin/me', accessToken);
      if (!res.ok) return false;
      const body = (await res.json().catch(() => ({}))) as { allowed?: boolean };
      if (body.allowed) {
        router.replace('/admin');
        return true;
      }
      return false;
    },
    [router],
  );

  const finalizeOnboarding = useCallback(
    async (session: Session, res: Response, opts?: { quiet?: boolean }) => {
      const data = (await res.json().catch(() => ({}))) as {
        created?: boolean;
        message?: string;
      };
      if (!res.ok) {
        if (!opts?.quiet) {
          setInfoVariant('default');
          setInfo(typeof data.message === 'string' ? data.message : 'Could not complete setup.');
        }
        return 'error' as const;
      }
      if (data.created === false) {
        writeAuthNoticeForDashboard(DUPLICATE_WORKSPACE_MSG);
        if (!opts?.quiet) {
          setInfoVariant('notice');
          setInfo(`${DUPLICATE_WORKSPACE_MSG} Taking you to your dashboard…`);
          await refreshMe(session.access_token);
          await new Promise((r) => setTimeout(r, 1200));
        } else {
          await refreshMe(session.access_token);
        }
        clearPending();
        router.replace(consumeGmailConnectedRedirect(safeNext, gmailConnectedParam));
        return 'navigated' as const;
      }
      clearPending();
      await refreshMe(session.access_token);
      router.replace(consumeGmailConnectedRedirect(safeNext, gmailConnectedParam));
      return 'navigated' as const;
    },
    [refreshMe, router, safeNext, clearPending, gmailConnectedParam],
  );

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

      if (await redirectIfPlatformAdmin(token)) {
        return;
      }

      if (!status.needs_onboarding && status.user) {
        if (!me) {
          return;
        }
        router.replace(
          consumeGmailConnectedRedirect(postLoginPath(status.user.role, safeNext), gmailConnectedParam),
        );
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
            const outcome = await finalizeOnboarding(session, onboardRes, { quiet: true });
            if (cancelled) return;
            if (outcome === 'navigated') return;
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
  }, [
    authCtxLoading,
    authCtxError,
    me,
    router,
    safeNext,
    hasExplicitNext,
    completeFromEmail,
    finalizeOnboarding,
    redirectIfPlatformAdmin,
    gmailConnectedParam,
  ]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
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
      const status = (await statusRes.json().catch(() => ({}))) as {
        needs_onboarding?: boolean;
        user?: { role?: string };
      };
      if (await redirectIfPlatformAdmin(session.access_token)) {
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
            const outcome = await finalizeOnboarding(session, onboardRes, { quiet: true });
            if (outcome === 'navigated') return;
          }
        }
        setPhase('onboarding');
        return;
      }
      await refreshMe(session.access_token);
      router.replace(
        consumeGmailConnectedRedirect(postLoginPath(status.user?.role, safeNext), gmailConnectedParam),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCeo = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
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
        setInfoVariant('notice');
        setInfo(mapSupabaseSignUpError(error.message));
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
        await finalizeOnboarding(session, onboardRes, { quiet: false });
        return;
      }
      setInfoVariant('default');
      setInfo('Check your email to verify your account, then sign in.');
    } finally {
      setLoading(false);
    }
  };

  const handleOnboarding = async (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
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
      await finalizeOnboarding(session, res, { quiet: false });
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
              <p
                className={`mt-4 text-sm ${
                  infoVariant === 'notice'
                    ? 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950'
                    : 'text-gray-500'
                }`}
                role="status"
              >
                {info}
              </p>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={`relative grid grid-cols-1 lg:grid-cols-2 ${shellClass}`}>
      {showAuthQuickFill() ? (
        <button
          type="button"
          title="Fill demo credentials (development)"
          aria-label="Fill demo email and password for quick sign-in"
          onClick={() => {
            setTab('login');
            setEmail(DEV_ADMIN_EMAIL);
            setPassword(DEV_ADMIN_PASSWORD);
            clearFeedback();
          }}
          className="fixed right-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white/90 text-gray-600 shadow-sm backdrop-blur-sm transition hover:bg-gray-50 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <span className="sr-only">Admin quick fill</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-5 w-5"
            aria-hidden
          >
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </button>
      ) : null}
      <BrandingPanel />
      <main className="flex items-center justify-center px-6 py-12 lg:px-12">
        <div className={cardClass}>
          <div className="mb-8 flex rounded-lg bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTab('login');
                clearFeedback();
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
                clearFeedback();
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
                  <PasswordInput
                    required
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
                      <PasswordInput
                        required
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
                      clearFeedback();
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
            <p
              className={`mt-4 text-sm ${
                infoVariant === 'notice'
                  ? 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950'
                  : 'text-gray-500'
              }`}
              role="status"
            >
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
