'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

type AppShellProps = {
  role: string;
  companyName?: string | null;
  title: string;
  subtitle: string;
  lastSyncLabel?: string | null;
  nextIngestionCountdownLabel?: string | null;
  isActive?: boolean;
  aiBriefingsEnabled?: boolean;
  mailboxCrawlEnabled?: boolean;
  onRefresh?: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
};

function isManagerRole(role: string): boolean {
  return role === 'HEAD' || role === 'MANAGER';
}

function navItemClass(active: boolean): string {
  return active
    ? 'block w-full rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20'
    : 'block w-full rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-white/80 hover:text-slate-900';
}

export function AppShell({
  role,
  companyName,
  title,
  subtitle,
  lastSyncLabel,
  nextIngestionCountdownLabel,
  isActive = true,
  aiBriefingsEnabled,
  mailboxCrawlEnabled,
  onRefresh,
  onSignOut,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [locHash, setLocHash] = useState('');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setLocHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [pathname]);

  const showOrg = role === 'CEO' || isManagerRole(role);
  const isCeo = role === 'CEO';
  const isHead = isManagerRole(role);
  const isEmployee = role === 'EMPLOYEE';
  const roleLabel = isHead ? 'Manager' : isEmployee ? 'Employee' : 'CEO';
  const deptAlertsFocus = pathname === '/departments' && locHash === '#team-members';
  const managerMessagesActive = pathname === '/manager-messages';

  return (
    <div className="min-h-screen bg-surface text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1440px]">
        <aside className="sticky top-0 z-20 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white/90 px-4 py-6 backdrop-blur-sm lg:flex">
          <div className="mb-6 shrink-0">
            <p className="bg-gradient-to-r from-brand-600 to-violet-600 bg-clip-text text-lg font-bold tracking-tight text-transparent">
              AI Auto Mail
            </p>
            <p className="mt-1 text-xs text-slate-500">Follow-up workspace</p>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Main">
            <div className="flex flex-col gap-1.5 pb-1">
              <Link href="/dashboard" className={navItemClass(pathname === '/dashboard')}>
                Dashboard
              </Link>

              {isEmployee ? (
                <Link href="/messages" className={navItemClass(pathname === '/messages')}>
                  Messages & alerts
                </Link>
              ) : null}

              {showOrg && isCeo ? (
                <>
                  <Link href="/departments" className={navItemClass(pathname === '/departments')}>
                    Departments
                  </Link>
                  <Link href="/employees" className={navItemClass(pathname === '/employees')}>
                    Employees
                  </Link>
                </>
              ) : null}

              {showOrg && isHead ? (
                <Link href="/employees" className={navItemClass(pathname === '/employees')}>
                  Team
                </Link>
              ) : null}

              {!isEmployee && showOrg && isHead ? (
                <>
                  <Link href="/manager-messages" className={navItemClass(managerMessagesActive)}>
                    Conversations
                  </Link>
                  <Link href="/departments#team-members" className={navItemClass(deptAlertsFocus)}>
                    Alerts
                  </Link>
                </>
              ) : null}

              {showOrg ? (
                <Link href="/ai-reports" className={navItemClass(pathname === '/ai-reports')}>
                  Reports
                </Link>
              ) : null}

              <Link href="/settings" className={navItemClass(pathname === '/settings')}>
                Settings
              </Link>
            </div>
          </nav>

          <div className="mt-auto shrink-0 border-t border-slate-100 pt-4">
            <div className="rounded-xl border border-slate-100 bg-surface-muted/80 px-3 py-3">
              <p className="text-xs font-semibold text-slate-800">{roleLabel}</p>
              {companyName ? <p className="mt-0.5 truncate text-[11px] text-slate-500">{companyName}</p> : null}
            </div>

            <button
              type="button"
              onClick={onSignOut}
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-content flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
            <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
                <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-card">
                <span
                  className={`h-2 w-2 rounded-full ${
                    mailboxCrawlEnabled === false ? 'bg-slate-300' : isActive ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                <span className="text-sm text-slate-600">
                  {mailboxCrawlEnabled === false ? 'Sync paused' : isActive ? 'In sync' : 'Sync issue'}
                </span>
                {aiBriefingsEnabled === false ? (
                  <span
                    className="rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200/80"
                    title="AI briefings disabled in Settings"
                  >
                    AI off
                  </span>
                ) : null}
                {lastSyncLabel ? <span className="text-xs text-slate-400">· {lastSyncLabel}</span> : null}
                {nextIngestionCountdownLabel ? (
                  <span className="text-xs tabular-nums text-slate-400">· Next {nextIngestionCountdownLabel}</span>
                ) : null}
                {onRefresh ? (
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="ml-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Refresh
                  </button>
                ) : null}
              </div>
            </header>

            <div className="flex flex-col gap-8">{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
