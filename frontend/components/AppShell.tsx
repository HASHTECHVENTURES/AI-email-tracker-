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
  /** Countdown until next scheduled Gmail ingestion (read mailboxes), e.g. MM:SS */
  nextIngestionCountdownLabel?: string | null;
  isActive?: boolean;
  onRefresh?: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
};

function isManagerRole(role: string): boolean {
  return role === 'HEAD' || role === 'MANAGER';
}

function navItemClass(active: boolean): string {
  return active
    ? 'block w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white'
    : 'block w-full rounded-lg px-3 py-2 text-sm font-medium text-gray-500 transition-all duration-200 hover:bg-gray-100 hover:text-gray-900';
}

export function AppShell({
  role,
  companyName,
  title,
  subtitle,
  lastSyncLabel,
  nextIngestionCountdownLabel,
  isActive = true,
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
  const messagesAlertsFocus = pathname === '/messages' && locHash === '#manager-alerts-new';
  const managerMessagesActive = pathname === '/manager-messages';

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-gray-200 bg-white p-6 lg:block">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">AI Auto Mail</p>
            <p className="mt-2 text-sm text-gray-500">Follow-up Intelligence</p>
            {isCeo ? (
              <p className="mt-3 rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] leading-snug text-slate-600">
                Company-wide access — org structure and all teams.
              </p>
            ) : null}
            {isHead ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
                Manager portal — follow-ups and mailboxes are limited to your department.
              </p>
            ) : null}
          </div>

          <nav className="space-y-2">
            <Link href="/dashboard" className={navItemClass(pathname === '/dashboard')}>
              Dashboard
            </Link>
            {isEmployee ? (
              <>
                <Link
                  href="/messages"
                  title="All notes from your manager"
                  className={navItemClass(pathname === '/messages' && !messagesAlertsFocus)}
                >
                  Messages
                </Link>
                <Link
                  href="/messages#manager-alerts-new"
                  title="Jump to new manager alerts"
                  className={navItemClass(pathname === '/messages' && messagesAlertsFocus)}
                >
                  Alerts
                </Link>
              </>
            ) : null}
            {isHead ? (
              <>
                <Link
                  href="/manager-messages"
                  title="Messages you sent to your team"
                  className={navItemClass(managerMessagesActive)}
                >
                  Messages
                </Link>
                <Link
                  href="/departments#team-members"
                  title="Send alerts to your team"
                  className={navItemClass(deptAlertsFocus)}
                >
                  Alerts
                </Link>
                <Link
                  href="/departments"
                  title="Department overview and team"
                  className={navItemClass(pathname === '/departments' && !deptAlertsFocus)}
                >
                  My department
                </Link>
              </>
            ) : null}
            {showOrg && isCeo ? (
              <Link
                href="/departments"
                title="Create departments and assign managers"
                className={navItemClass(pathname === '/departments')}
              >
                Departments
              </Link>
            ) : null}
            {showOrg && isCeo ? (
              <Link href="/employees" className={navItemClass(pathname === '/employees')}>
                Employee list
              </Link>
            ) : null}
            {showOrg && isHead ? (
              <Link
                href="/employees"
                title="Mailboxes in your department only"
                className={navItemClass(pathname === '/employees')}
              >
                Team mailboxes
              </Link>
            ) : null}
            {showOrg && isCeo ? (
              <Link href="/employees/add" className={navItemClass(pathname === '/employees/add')}>
                Add employee
              </Link>
            ) : null}
            {showOrg && isHead ? (
              <Link
                href="/employees/add"
                title="Add someone to your department"
                className={navItemClass(pathname === '/employees/add')}
              >
                Add team member
              </Link>
            ) : null}
            {showOrg && (
              <Link href="/ai-reports" className={navItemClass(pathname === '/ai-reports')}>
                AI Reports
              </Link>
            )}
            <Link
              href="/email-archive"
              className={navItemClass(pathname === '/email-archive')}
            >
              Email archive
            </Link>
            <Link href="/settings" className={navItemClass(pathname === '/settings')}>
              Settings
            </Link>
          </nav>

          <button
            type="button"
            onClick={onSignOut}
            className="mt-8 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm"
          >
            Sign out
          </button>
        </aside>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
              <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Portal: {roleLabel}
                {companyName ? ` • Company: ${companyName}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2 shadow-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <span className="text-sm text-gray-600">{isActive ? 'System active' : 'System inactive'}</span>
              {lastSyncLabel ? <span className="text-sm text-gray-500">Last sync: {lastSyncLabel}</span> : null}
              {nextIngestionCountdownLabel ? (
                <span
                  className="text-sm tabular-nums text-gray-500"
                  title="Time until the next automatic Gmail fetch for connected mailboxes (not outbound sending)."
                >
                  Next Gmail fetch: {nextIngestionCountdownLabel}
                </span>
              ) : null}
              {onRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm"
                >
                  Refresh
                </button>
              ) : null}
            </div>
          </header>

          <div className="space-y-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
