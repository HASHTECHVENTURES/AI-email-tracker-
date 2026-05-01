'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onRefetch` when the user returns to this browser tab or window (focus / visibility).
 * Complements fetch-on-mount patterns so data from other tabs, devices, or background jobs
 * appears without a manual full page refresh.
 *
 * Not true realtime (no WebSocket); debounced to avoid storms when alt-tabbing quickly.
 */
export function useRefetchOnFocus(onRefetch: () => void, enabled: boolean): void {
  const ref = useRef(onRefetch);
  ref.current = onRefetch;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof document === 'undefined') return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (document.visibilityState !== 'visible') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        ref.current();
      }, 250);
    };

    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);

    return () => {
      if (debounce) clearTimeout(debounce);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [enabled]);
}
