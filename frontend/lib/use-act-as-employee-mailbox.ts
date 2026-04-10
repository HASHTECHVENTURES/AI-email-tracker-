'use client';

import { useEffect, useState } from 'react';
import { readActAsEmployeeViewEnabled } from '@/lib/api';

/**
 * True when a department manager turned on “Mailbox (employee)” view (sessionStorage).
 * Re-renders when the toggle changes (custom event + storage).
 */
export function useActAsEmployeeMailboxView(enabled: boolean): boolean {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setV(false);
      return;
    }
    const sync = () => setV(readActAsEmployeeViewEnabled());
    sync();
    const h = () => sync();
    window.addEventListener('ai-et-act-as-changed', h);
    window.addEventListener('storage', h);
    return () => {
      window.removeEventListener('ai-et-act-as-changed', h);
      window.removeEventListener('storage', h);
    };
  }, [enabled]);
  return v;
}
