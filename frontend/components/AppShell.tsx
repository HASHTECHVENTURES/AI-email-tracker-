'use client';

import type { MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

type AppShellProps = {
  role: string;
  companyName?: string | null;
  /** Signed-in person's name (e.g. CEO); falls back to email at call sites when name is empty. */
  userDisplayName?: string | null;
  /** Shown above the page title (e.g. time-based greeting). */
  titleEyebrow?: ReactNode;
  title: string;
  subtitle: string;
  lastSyncLabel?: string | null;
  nextIngestionCountdownLabel?: string | null;
  nextReportCountdownLabel?: string | null;
  isActive?: boolean;
  aiBriefingsEnabled?: boolean;
  mailboxCrawlEnabled?: boolean;
  onRefresh?: () => void;
  onSignOut: () => void;
  children: ReactNode;
};

function isManagerRole(role: string): boolean {
  return role === 'HEAD' || role === 'MANAGER';
}

function navItemClass(active: boolean): string {
  return active
    ? 'block w-full rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20'
    : 'block w-full rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-white/80 hover:text-slate-900';
}

/** Compact chips for the mobile / small-screen strip (sidebar is `lg`+ only). */
function navMobileClass(active: boolean): string {
  return active
    ? 'inline-flex shrink-0 rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm'
    : 'inline-flex shrink-0 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50';
}

/**
 * Next.js App Router `<Link>` often does not navigate when only the URL fragment changes
 * on the same pathname (`/my-email` → `/my-email#...`), so `hashchange` never fires.
 * Force the fragment so the My Email page tab state updates.
 */
function onMyEmailHashNavClick(
  e: MouseEvent<HTMLAnchorElement>,
  pathname: string,
  tab: 'ceo' | 'manager',
) {
  if (pathname !== '/my-email') return;
  e.preventDefault();
  if (tab === 'ceo') {
    if (window.location.hash) window.location.hash = '';
    return;
  }
  const id = 'manager-mailboxes';
  if (window.location.hash !== `#${id}`) {
    window.location.hash = id;
  }
}

function ShellStatusStrip({
  mailboxCrawlEnabled,
  isActive,
  aiBriefingsEnabled,
  lastSyncLabel,
  nextIngestionCountdownLabel,
  nextReportCountdownLabel,
  onRefresh,
}: {
  mailboxCrawlEnabled?: boolean;
  isActive: boolean;
  aiBriefingsEnabled?: boolean;
  lastSyncLabel?: string | null;
  nextIngestionCountdownLabel?: string | null;
  nextReportCountdownLabel?: string | null;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-card hover:shadow-card-hover">
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
      {nextReportCountdownLabel ? (
        <span className="text-xs tabular-nums text-slate-400" title="Time until the next scheduled executive report">
          · Report {nextReportCountdownLabel}
        </span>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          className="ml-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:shadow-sm"
        >
          Refresh
        </button>
      ) : null}
    </div>
  );
}

export function AppShell({
  role,
  companyName,
  userDisplayName,
  titleEyebrow,
  title,
  subtitle,
  lastSyncLabel,
  nextIngestionCountdownLabel,
  nextReportCountdownLabel,
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

  const isPlatformAdmin = role === 'PLATFORM_ADMIN';
  const showOrg = (role === 'CEO' || isManagerRole(role)) && !isPlatformAdmin;
  const isCeo = role === 'CEO';
  const isHead = isManagerRole(role);
  const isEmployee = role === 'EMPLOYEE';
  const showMyEmail = isCeo && !isPlatformAdmin;
  const roleLabel = isPlatformAdmin
    ? 'Platform admin'
    : isHead
      ? 'Manager'
      : isEmployee
        ? 'Employee'
        : 'CEO';
  const deptAlertsFocus = pathname === '/departments' && locHash === '#team-members';
  const myEmailHome =
    pathname === '/my-email' &&
    locHash !== '#manager-mailboxes' &&
    locHash !== '#team-mailboxes-ceo';
  const managerMailFocus =
    pathname === '/my-email' && locHash === '#manager-mailboxes';
  const managerMessagesActive = pathname === '/manager-messages';
  const brandTitle = companyName?.trim() || 'AI Auto Mail';
  const personLine = userDisplayName?.trim() || null;

  return (
    <div className="min-h-screen bg-surface text-slate-900">
      <div className="app-shell-body mx-auto flex min-h-screen max-w-[1440px] flex-col lg:flex-row">
        <aside className="app-shell-sidebar sticky top-0 z-20 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white px-4 py-6 lg:flex">
          <div className="mb-6 shrink-0">
            <p
              className="max-w-full truncate bg-gradient-to-r from-brand-600 to-violet-600 bg-clip-text text-lg font-bold tracking-tight text-transparent"
              title={brandTitle}
            >
              {brandTitle}
            </p>
            <p className="mt-1 text-xs text-slate-500">Follow-up workspace</p>
          </div>

          {/* Scroll lives on this wrapper (not <nav>) so overflow-y does not clip link text on the inline axis. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]">
            <nav aria-label="Main">
              <div className="flex flex-col gap-1.5 pb-1">
              {isPlatformAdmin ? (
                <Link href="/admin" className={navItemClass(pathname === '/admin')}>
                  Platform admin
                </Link>
              ) : (
                <Link href="/dashboard" className={navItemClass(pathname === '/dashboard')}>
                  Dashboard
                </Link>
              )}

              {showMyEmail ? (
                <>
                  <Link
                    href="/my-email"
                    className={navItemClass(myEmailHome)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'ceo')}
                  >
                    My Email
                  </Link>
                  <Link
                    href="/my-email#manager-mailboxes"
                    className={navItemClass(managerMailFocus)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'manager')}
                  >
                    Manager mail
                  </Link>
                </>
              ) : null}

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
                  <Link href="/ai-reports" className={navItemClass(pathname === '/ai-reports')}>
                    Reports
                  </Link>
                </>
              ) : null}

              {showOrg && isHead ? (
                <Link href="/employees" className={navItemClass(pathname === '/employees')}>
                  Team
                </Link>
              ) : null}

              {showOrg && isHead ? (
                <Link href="/my-mail" className={navItemClass(pathname === '/my-mail')}>
                  My mail
                </Link>
              ) : null}

              {showOrg && isHead ? (
                <>
                  <Link href="/manager-messages" className={navItemClass(managerMessagesActive)}>
                    Conversations
                  </Link>
                  <Link href="/departments#team-members" className={navItemClass(deptAlertsFocus)}>
                    Alerts
                  </Link>
                </>
              ) : null}

              {!isPlatformAdmin ? (
                <Link href="/settings" className={navItemClass(pathname === '/settings')}>
                  Settings
                </Link>
              ) : null}
            </div>
            </nav>
          </div>

          <div className="mt-auto shrink-0 border-t border-slate-100 pt-4">
            <div className="space-y-1 rounded-xl border border-slate-100 bg-surface-muted/80 px-3 py-3">
              {personLine ? (
                <p className="truncate text-sm font-bold text-slate-900" title={personLine}>
                  {personLine}
                </p>
              ) : null}
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{roleLabel}</p>
            </div>

            <button
              type="button"
              onClick={onSignOut}
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm"
            >
              Sign out
            </button>
          </div>
        </aside>

        <div className="app-shell-main-column flex min-w-0 flex-1 flex-col">
          {/* Navigation + account on small viewports (sidebar is desktop-only). */}
          <div className="app-shell-mobile-nav sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-3 py-3 shadow-sm backdrop-blur-sm lg:hidden">
            <p
              className="truncate bg-gradient-to-r from-brand-600 to-violet-600 bg-clip-text text-base font-bold tracking-tight text-transparent"
              title={brandTitle}
            >
              {brandTitle}
            </p>
            <nav
              className="app-shell-mobile-nav-links mt-2 flex flex-wrap gap-1.5"
              aria-label="Main mobile"
            >
              {isPlatformAdmin ? (
                <Link href="/admin" className={navMobileClass(pathname === '/admin')}>
                  Admin
                </Link>
              ) : (
                <Link href="/dashboard" className={navMobileClass(pathname === '/dashboard')}>
                  Dashboard
                </Link>
              )}
              {showMyEmail ? (
                <>
                  <Link
                    href="/my-email"
                    className={navMobileClass(myEmailHome)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'ceo')}
                  >
                    My Email
                  </Link>
                  <Link
                    href="/my-email#manager-mailboxes"
                    className={navMobileClass(managerMailFocus)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'manager')}
                  >
                    Manager mail
                  </Link>
                </>
              ) : null}
              {isEmployee ? (
                <Link href="/messages" className={navMobileClass(pathname === '/messages')}>
                  Messages
                </Link>
              ) : null}
              {showOrg && isCeo ? (
                <>
                  <Link href="/departments" className={navMobileClass(pathname === '/departments')}>
                    Departments
                  </Link>
                  <Link href="/employees" className={navMobileClass(pathname === '/employees')}>
                    Employees
                  </Link>
                  <Link href="/ai-reports" className={navMobileClass(pathname === '/ai-reports')}>
                    Reports
                  </Link>
                </>
              ) : null}
              {showOrg && isHead ? (
                <Link href="/employees" className={navMobileClass(pathname === '/employees')}>
                  Team
                </Link>
              ) : null}
              {showOrg && isHead ? (
                <Link href="/my-mail" className={navMobileClass(pathname === '/my-mail')}>
                  My mail
                </Link>
              ) : null}
              {showOrg && isHead ? (
                <>
                  <Link href="/manager-messages" className={navMobileClass(managerMessagesActive)}>
                    Conversations
                  </Link>
                  <Link href="/departments#team-members" className={navMobileClass(deptAlertsFocus)}>
                    Alerts
                  </Link>
                </>
              ) : null}
              {!isPlatformAdmin ? (
                <Link href="/settings" className={navMobileClass(pathname === '/settings')}>
                  Settings
                </Link>
              ) : null}
            </nav>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <div className="min-w-0 text-xs text-slate-600">
                {personLine ? <span className="font-semibold text-slate-800">{personLine}</span> : null}
                {personLine ? <span className="text-slate-400"> · </span> : null}
                <span className="uppercase tracking-wide text-slate-400">{roleLabel}</span>
              </div>
              <button
                type="button"
                onClick={onSignOut}
                className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:shadow-sm"
              >
                Sign out
              </button>
            </div>
          </div>

          <main className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-content flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
            <header className="app-shell-page-header mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                {titleEyebrow}
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
                <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>
              </div>
              <ShellStatusStrip
                mailboxCrawlEnabled={mailboxCrawlEnabled}
                isActive={isActive}
                aiBriefingsEnabled={aiBriefingsEnabled}
                lastSyncLabel={lastSyncLabel}
                nextIngestionCountdownLabel={nextIngestionCountdownLabel}
                nextReportCountdownLabel={nextReportCountdownLabel}
                onRefresh={onRefresh}
              />
            </header>

            <div className="flex flex-col gap-8">{children}</div>
          </div>
        </main>
        </div>
      </div>
    </div>
  );
}
