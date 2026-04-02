'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const linkStyle = (active: boolean): React.CSSProperties => ({
  color: active ? 'var(--text)' : 'var(--muted)',
  textDecoration: 'none',
  fontWeight: active ? 600 : 400,
  fontSize: '0.95rem',
});

export function WorkspaceNav({
  role,
  onSignOut,
  statusLine,
}: {
  role: string;
  onSignOut: () => void;
  /** System status (e.g. last sync) — shown under the nav on wide layouts */
  statusLine?: { lastSyncLabel: string | null; isActive?: boolean };
}) {
  const pathname = usePathname();
  const [locHash, setLocHash] = useState('');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setLocHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [pathname]);

  const isCeo = role === 'CEO';
  const isHead = role === 'HEAD' || role === 'MANAGER';
  const isEmployee = role === 'EMPLOYEE';
  const showOrg = isCeo || isHead;
  const deptAlertsFocus = pathname === '/departments' && locHash === '#team-members';
  const messagesAlertsFocus = pathname === '/messages' && locHash === '#manager-alerts-new';
  const managerMessagesActive = pathname === '/manager-messages';

  return (
    <header
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginBottom: 28,
        paddingBottom: 16,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
      <nav style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
        <Link href="/dashboard" style={linkStyle(pathname === '/dashboard')}>
          Dashboard
        </Link>
        {isEmployee ? (
          <>
            <Link href="/messages" style={linkStyle(pathname === '/messages' && !messagesAlertsFocus)}>
              Messages
            </Link>
            <Link href="/messages#manager-alerts-new" style={linkStyle(pathname === '/messages' && messagesAlertsFocus)}>
              Alerts
            </Link>
          </>
        ) : null}
        {isHead ? (
          <>
            <Link href="/manager-messages" style={linkStyle(managerMessagesActive)}>
              Messages
            </Link>
            <Link href="/departments#team-members" style={linkStyle(deptAlertsFocus)}>
              Alerts
            </Link>
            <Link href="/departments" style={linkStyle(pathname === '/departments' && !deptAlertsFocus)}>
              My department
            </Link>
          </>
        ) : null}
        {showOrg && isCeo ? (
          <Link href="/departments" style={linkStyle(pathname === '/departments')}>
            Departments
          </Link>
        ) : null}
        {showOrg && isCeo ? (
          <Link href="/employees" style={linkStyle(pathname === '/employees')}>
            Employee list
          </Link>
        ) : null}
        {showOrg && isHead ? (
          <Link href="/employees" style={linkStyle(pathname === '/employees')}>
            Team mailboxes
          </Link>
        ) : null}
        {showOrg && isCeo ? (
          <Link href="/employees/add" style={linkStyle(pathname === '/employees/add')}>
            Add employee
          </Link>
        ) : null}
        {showOrg && isHead ? (
          <Link href="/employees/add" style={linkStyle(pathname === '/employees/add')}>
            Add team member
          </Link>
        ) : null}
        {showOrg && (
          <Link href="/ai-reports" style={linkStyle(pathname === '/ai-reports')}>
            AI Reports
          </Link>
        )}
        <Link href="/email-archive" style={linkStyle(pathname === '/email-archive')}>
          Email archive
        </Link>
      </nav>
      <button
        type="button"
        onClick={onSignOut}
        style={{
          padding: '8px 14px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--panel)',
          color: 'var(--text)',
          cursor: 'pointer',
          fontSize: '0.9rem',
        }}
      >
        Sign out
      </button>
      </div>
      {statusLine && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            fontSize: '0.85rem',
            color: 'var(--muted)',
          }}
        >
          <span style={{ color: statusLine.isActive === false ? '#f87171' : '#34d399' }}>●</span>
          <span>{statusLine.isActive === false ? 'System inactive' : 'System active'}</span>
          {statusLine.lastSyncLabel && (
            <span>
              Last sync: <span style={{ color: 'var(--text)' }}>{statusLine.lastSyncLabel}</span>
            </span>
          )}
        </div>
      )}
    </header>
  );
}
