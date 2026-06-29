'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/companies', label: 'Companies' },
  { href: '/admin/billing', label: 'Billing & usage' },
  { href: '/admin/activity', label: 'Activity' },
] as const;

function navActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function navItemClass(active: boolean): string {
  return active
    ? 'block w-full rounded-xl bg-gradient-to-r from-slate-800 to-slate-600 px-3 py-2.5 text-sm font-semibold text-white shadow-md'
    : 'block w-full rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-white/80 hover:text-slate-900';
}

function navMobileClass(active: boolean): string {
  return active
    ? 'inline-flex shrink-0 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm'
    : 'inline-flex shrink-0 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50';
}

export function AdminShell({
  title,
  subtitle,
  userDisplayName,
  onSignOut,
  children,
}: {
  title: string;
  subtitle?: string;
  userDisplayName?: string | null;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const personLine = userDisplayName?.trim() || null;

  return (
    <div className="min-h-screen bg-surface text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col lg:flex-row">
        <aside className="sticky top-0 z-20 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white px-4 py-6 lg:flex">
          <div className="mb-6 shrink-0">
            <p className="text-lg font-bold tracking-tight text-slate-900">Platform Admin</p>
            <p className="mt-1 text-xs text-slate-500">Tenant operations &amp; billing</p>
          </div>

          <nav aria-label="Admin" className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-1.5">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={navItemClass(navActive(pathname, item.href, 'exact' in item ? item.exact : false))}
                >
                  {item.label}
                </Link>
              ))}
              <Link
                href="/admin/companies/new"
                className="mt-2 block w-full rounded-xl border border-dashed border-slate-300 px-3 py-2.5 text-center text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"
              >
                + Add company
              </Link>
            </div>
          </nav>

          <div className="mt-auto shrink-0 border-t border-slate-100 pt-4">
            <div className="space-y-1 rounded-xl border border-slate-100 bg-surface-muted/80 px-3 py-3">
              {personLine ? (
                <p className="truncate text-sm font-bold text-slate-900" title={personLine}>
                  {personLine}
                </p>
              ) : null}
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Platform admin</p>
              <button
                type="button"
                onClick={onSignOut}
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-3 py-3 shadow-sm backdrop-blur-sm lg:hidden">
            <p className="text-base font-bold text-slate-900">Platform Admin</p>
            <nav className="mt-2 flex flex-wrap gap-1.5" aria-label="Admin mobile">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={navMobileClass(navActive(pathname, item.href, 'exact' in item ? item.exact : false))}
                >
                  {item.label}
                </Link>
              ))}
              <Link href="/admin/companies/new" className={navMobileClass(pathname === '/admin/companies/new')}>
                + Company
              </Link>
            </nav>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <span className="truncate text-xs text-slate-600">{personLine ?? 'Admin'}</span>
              <button
                type="button"
                onClick={onSignOut}
                className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                Sign out
              </button>
            </div>
          </div>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="mx-auto w-full max-w-content flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
              <header className="mb-8">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
                {subtitle?.trim() ? (
                  <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>
                ) : null}
              </header>
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
