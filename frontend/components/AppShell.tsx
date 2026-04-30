'use client';

import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api';
import { setActAsEmployeeView } from '@/lib/api';
import { isDepartmentManagerRole } from '@/lib/roles';
import { useActAsEmployeeMailboxView } from '@/lib/use-act-as-employee-mailbox';

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
  /**
   * My Email: before the user links Gmail, show a neutral strip instead of red «Sync issue».
   * Other pages omit (default) and keep In sync / Sync issue from `isActive`.
   */
  syncStripKind?: 'default' | 'gmail_not_linked';
  aiBriefingsEnabled?: boolean;
  mailboxCrawlEnabled?: boolean;
  onRefresh?: () => void;
  onSignOut: () => void;
  children: ReactNode;
};

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

function SafeLink(props: ComponentProps<typeof Link>) {
  return <Link suppressHydrationWarning {...props} />;
}

/**
 * Next.js App Router `<Link>` often does not navigate when only the URL fragment changes
 * on the same pathname (`/my-email` → `/my-email#...`), so `hashchange` never fires.
 * Force the fragment so the My Email page tab state updates.
 */
function onMyEmailHashNavClick(
  e: MouseEvent<HTMLAnchorElement>,
  pathname: string,
  tab: 'ceo' | 'manager' | 'team',
) {
  if (pathname !== '/my-email') return;
  e.preventDefault();
  if (tab === 'ceo') {
    if (window.location.hash) window.location.hash = '';
    return;
  }
  const id = tab === 'manager' ? 'manager-mailboxes' : 'team-mailboxes-ceo';
  if (window.location.hash !== `#${id}`) {
    window.location.hash = id;
  }
}

function ShellStatusStrip({
  mailboxCrawlEnabled,
  isActive,
  syncStripKind,
  aiBriefingsEnabled,
  lastSyncLabel,
  nextIngestionCountdownLabel,
  nextReportCountdownLabel,
  onRefresh,
}: {
  mailboxCrawlEnabled?: boolean;
  isActive: boolean;
  syncStripKind?: 'default' | 'gmail_not_linked';
  aiBriefingsEnabled?: boolean;
  lastSyncLabel?: string | null;
  nextIngestionCountdownLabel?: string | null;
  nextReportCountdownLabel?: string | null;
  onRefresh?: () => void;
}) {
  const strip =
    mailboxCrawlEnabled === false
      ? { dot: 'bg-slate-300', text: 'Sync paused' as const }
      : syncStripKind === 'gmail_not_linked'
        ? { dot: 'bg-slate-400', text: 'Gmail not connected' as const }
        : isActive
          ? { dot: 'bg-emerald-500', text: 'In sync' as const }
          : { dot: 'bg-red-500', text: 'Sync issue' as const };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-card hover:shadow-card-hover">
      <span className={`h-2 w-2 rounded-full ${strip.dot}`} />
      <span className="text-sm text-slate-600">{strip.text}</span>
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
  syncStripKind = 'default',
  aiBriefingsEnabled,
  mailboxCrawlEnabled,
  onRefresh,
  onSignOut,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, token, managerActiveDepartmentId, setManagerActiveDepartmentId } = useAuth();
  const managedTeams = me?.managed_departments ?? [];
  const [fallbackMailboxCrawlEnabled, setFallbackMailboxCrawlEnabled] = useState<boolean | undefined>(undefined);
  const [locHash, setLocHash] = useState('');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setLocHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [pathname]);

  const isPlatformAdmin = role === 'PLATFORM_ADMIN';
  const showOrg = (role === 'CEO' || isDepartmentManagerRole(role)) && !isPlatformAdmin;
  const isCeo = role === 'CEO';
  const isHead = isDepartmentManagerRole(role);
  const isEmployee = role === 'EMPLOYEE';
  // Managers can act as Employees if they selected "Employee" at login.
  // The toggle UI is completely removed, so this state is driven entirely by login selection.
  const canActAsMailbox =
    isHead && !isPlatformAdmin && !!(me?.linked_employee_id?.trim());
  const actAsMailbox = useActAsEmployeeMailboxView(canActAsMailbox);
  /** Employee portal nav, or manager viewing their linked mailbox. */
  const mailboxNav = isEmployee || actAsMailbox;
  /** Employee/linked mailbox messages shortcut (hidden in manager sidebar to avoid duplicate comms entries). */
  const mailboxMessagesNav = (mailboxNav || canActAsMailbox) && !(isHead && !actAsMailbox);
  /** Manager-only sidebar (hidden in mailbox view). */
  const managerNavVisible = isHead && !isPlatformAdmin && !actAsMailbox;
  /** CEO (full My Email), department manager (HEAD), or Employee portal — Historical Search + scoped mailboxes. */
  const showMyEmail = (isCeo || isHead || isEmployee) && !isPlatformAdmin;
  const showMyEmailCeoHashNav = isCeo;
  const roleLabel = isPlatformAdmin
    ? 'Platform admin'
    : actAsMailbox
      ? 'Mailbox'
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
  const employeeMailFocus =
    pathname === '/my-email' && locHash === '#team-mailboxes-ceo';
  const managerMessagesActive = pathname === '/manager-messages';
  const teamMailSyncActive = pathname === '/team-mail-sync';
  const managerInboxActive = managerMessagesActive || deptAlertsFocus;
  const brandTitle = companyName?.trim() || 'AI Auto Mail';
  const personLine = userDisplayName?.trim() || null;
  const showTeamSwitcher =
    isHead && !isPlatformAdmin && (managedTeams.length > 1);
  const effectiveMailboxCrawlEnabled =
    mailboxCrawlEnabled === undefined ? fallbackMailboxCrawlEnabled : mailboxCrawlEnabled;

  useEffect(() => {
    if (mailboxCrawlEnabled !== undefined || !token || isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      const res = await apiFetch('/settings', token);
      if (!res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { email_crawl_enabled?: unknown };
      if (cancelled) return;
      setFallbackMailboxCrawlEnabled(body.email_crawl_enabled !== false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mailboxCrawlEnabled, token, isPlatformAdmin, pathname]);

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

          {showTeamSwitcher ? (
            <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/90 px-3 py-2.5">
              <label
                htmlFor="app-shell-active-team"
                className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500"
              >
                Active team
              </label>
              <select
                id="app-shell-active-team"
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={managerActiveDepartmentId ?? managedTeams[0]?.id ?? ''}
                onChange={(e) => {
                  setManagerActiveDepartmentId(e.target.value);
                  router.refresh();
                }}
              >
                {managedTeams.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* VIEW toggle removed — role is fixed at login */}

          {/* Scroll lives on this wrapper (not <nav>) so overflow-y does not clip link text on the inline axis. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]">
            <nav aria-label="Main">
              <div className="flex flex-col gap-1.5 pb-1">
              {isPlatformAdmin ? (
                <>
                  <a
                    href="/admin"
                    className={navItemClass(pathname === '/admin' && !locHash)}
                    onClick={(e) => {
                      if (pathname === '/admin') {
                        e.preventDefault();
                        window.history.replaceState(null, '', '/admin');
                        window.dispatchEvent(new HashChangeEvent('hashchange'));
                      }
                    }}
                  >
                    Dashboard
                  </a>
                  <a href="/admin#companies" className={navItemClass(pathname === '/admin' && locHash === '#companies')}>
                    Companies
                  </a>
                  <a href="/admin#add-company" className={navItemClass(pathname === '/admin' && locHash === '#add-company')}>
                    Add company
                  </a>
                  <a href="/admin#kill-switches" className={navItemClass(pathname === '/admin' && locHash === '#kill-switches')}>
                    Kill switches
                  </a>
                </>
              ) : (
                <SafeLink href="/dashboard" className={navItemClass(pathname === '/dashboard')}>
                  Dashboard
                </SafeLink>
              )}

              {showMyEmail ? (
                <>
                  <SafeLink
                    href="/my-email"
                    className={navItemClass(myEmailHome)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'ceo')}
                  >
                    My Email
                  </SafeLink>
                  {showMyEmailCeoHashNav ? (
                    <>
                      <SafeLink
                        href="/my-email#manager-mailboxes"
                        className={navItemClass(managerMailFocus)}
                        onClick={(e) => onMyEmailHashNavClick(e, pathname, 'manager')}
                      >
                        Manager mail
                      </SafeLink>
                      <SafeLink
                        href="/my-email#team-mailboxes-ceo"
                        className={navItemClass(employeeMailFocus)}
                        onClick={(e) => onMyEmailHashNavClick(e, pathname, 'team')}
                      >
                        Employee mail
                      </SafeLink>
                    </>
                  ) : null}
                </>
              ) : null}

              {managerNavVisible ? (
                <SafeLink href="/team-mail-sync" className={navItemClass(teamMailSyncActive)}>
                  Team mail sync
                </SafeLink>
              ) : null}

              {mailboxMessagesNav ? (
                <SafeLink href="/messages" className={navItemClass(pathname === '/messages')}>
                  Messages & alerts
                </SafeLink>
              ) : null}

              {showOrg && isCeo ? (
                <>
                  <SafeLink href="/departments" className={navItemClass(pathname === '/departments')}>
                    Departments
                  </SafeLink>
                  <SafeLink href="/employees" className={navItemClass(pathname === '/employees')}>
                    Employees
                  </SafeLink>
                  <SafeLink href="/ai-reports" className={navItemClass(pathname === '/ai-reports')}>
                    Reports
                  </SafeLink>
                </>
              ) : null}

              {showOrg && managerNavVisible ? (
                <SafeLink href="/employees" className={navItemClass(pathname === '/employees')}>
                  Team
                </SafeLink>
              ) : null}

              {showOrg && managerNavVisible ? (
                <SafeLink href="/manager-messages" className={navItemClass(managerInboxActive)}>
                  Messages & alerts
                </SafeLink>
              ) : null}

              {!isPlatformAdmin ? (
                <SafeLink href="/settings" className={navItemClass(pathname === '/settings')}>
                  Settings
                </SafeLink>
              ) : null}

              {isCeo && !isPlatformAdmin ? (
                <SafeLink
                  href="/dashboard/scope"
                  className={navItemClass(pathname === '/dashboard/scope')}
                >
                  Dashboard scope
                </SafeLink>
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
            {showTeamSwitcher ? (
              <div className="mt-2">
                <label
                  htmlFor="app-shell-active-team-mobile"
                  className="sr-only"
                >
                  Active team
                </label>
                <select
                  id="app-shell-active-team-mobile"
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-800"
                  value={managerActiveDepartmentId ?? managedTeams[0]?.id ?? ''}
                  onChange={(e) => {
                    setManagerActiveDepartmentId(e.target.value);
                    router.refresh();
                  }}
                >
                  {managedTeams.map((d) => (
                    <option key={d.id} value={d.id}>
                      Team: {d.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <nav
              className="app-shell-mobile-nav-links mt-2 flex flex-wrap gap-1.5"
              aria-label="Main mobile"
            >
              {isPlatformAdmin ? (
                <>
                  <a
                    href="/admin"
                    className={navMobileClass(pathname === '/admin' && !locHash)}
                    onClick={(e) => {
                      if (pathname === '/admin') {
                        e.preventDefault();
                        window.history.replaceState(null, '', '/admin');
                        window.dispatchEvent(new HashChangeEvent('hashchange'));
                      }
                    }}
                  >
                    Dashboard
                  </a>
                  <a href="/admin#companies" className={navMobileClass(pathname === '/admin' && locHash === '#companies')}>
                    Companies
                  </a>
                  <a href="/admin#add-company" className={navMobileClass(pathname === '/admin' && locHash === '#add-company')}>
                    Add company
                  </a>
                  <a href="/admin#kill-switches" className={navMobileClass(pathname === '/admin' && locHash === '#kill-switches')}>
                    Kill switches
                  </a>
                </>
              ) : (
                <SafeLink href="/dashboard" className={navMobileClass(pathname === '/dashboard')}>
                  Dashboard
                </SafeLink>
              )}
              {showMyEmail ? (
                <>
                  <SafeLink
                    href="/my-email"
                    className={navMobileClass(myEmailHome)}
                    onClick={(e) => onMyEmailHashNavClick(e, pathname, 'ceo')}
                  >
                    My Email
                  </SafeLink>
                  {showMyEmailCeoHashNav ? (
                    <>
                      <SafeLink
                        href="/my-email#manager-mailboxes"
                        className={navMobileClass(managerMailFocus)}
                        onClick={(e) => onMyEmailHashNavClick(e, pathname, 'manager')}
                      >
                        Manager mail
                      </SafeLink>
                      <SafeLink
                        href="/my-email#team-mailboxes-ceo"
                        className={navMobileClass(employeeMailFocus)}
                        onClick={(e) => onMyEmailHashNavClick(e, pathname, 'team')}
                      >
                        Employee mail
                      </SafeLink>
                    </>
                  ) : null}
                </>
              ) : null}
              {managerNavVisible ? (
                <SafeLink href="/team-mail-sync" className={navMobileClass(teamMailSyncActive)}>
                  Team sync
                </SafeLink>
              ) : null}
              {mailboxMessagesNav ? (
                <SafeLink href="/messages" className={navMobileClass(pathname === '/messages')}>
                  Messages
                </SafeLink>
              ) : null}
              {showOrg && isCeo ? (
                <>
                  <SafeLink href="/departments" className={navMobileClass(pathname === '/departments')}>
                    Departments
                  </SafeLink>
                  <SafeLink href="/employees" className={navMobileClass(pathname === '/employees')}>
                    Employees
                  </SafeLink>
                  <SafeLink href="/ai-reports" className={navMobileClass(pathname === '/ai-reports')}>
                    Reports
                  </SafeLink>
                </>
              ) : null}
              {showOrg && managerNavVisible ? (
                <SafeLink href="/employees" className={navMobileClass(pathname === '/employees')}>
                  Team
                </SafeLink>
              ) : null}
              {showOrg && managerNavVisible ? (
                <SafeLink href="/manager-messages" className={navMobileClass(managerInboxActive)}>
                  Messages & alerts
                </SafeLink>
              ) : null}
              {!isPlatformAdmin ? (
                <SafeLink href="/settings" className={navMobileClass(pathname === '/settings')}>
                  Settings
                </SafeLink>
              ) : null}
              {isCeo && !isPlatformAdmin ? (
                <SafeLink href="/dashboard/scope" className={navMobileClass(pathname === '/dashboard/scope')}>
                  Scope
                </SafeLink>
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
                {subtitle?.trim() ? (
                  <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>
                ) : null}
              </div>
              <ShellStatusStrip
                mailboxCrawlEnabled={effectiveMailboxCrawlEnabled}
                isActive={isActive}
                syncStripKind={syncStripKind}
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
