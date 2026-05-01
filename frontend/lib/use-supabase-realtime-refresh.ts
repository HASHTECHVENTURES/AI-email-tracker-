'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

export type RealtimeTableSpec = {
  schema?: string;
  table: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
};

function tablesSignature(tables: readonly RealtimeTableSpec[]): string {
  return tables.map((t) => `${t.schema ?? 'public'}:${t.table}:${t.event ?? '*'}`).join('|');
}

/**
 * Subscribes to Supabase Realtime `postgres_changes` for the given tables and debounces
 * `onSignal` (typically refetch via your Nest API). Requires DB publication + RLS SELECT
 * for `authenticated` — see backend migration `024_supabase_realtime_rls_select.sql`.
 */
export function useSupabaseRealtimeRefresh(options: {
  enabled: boolean;
  channelSuffix: string;
  tables: readonly RealtimeTableSpec[];
  onSignal: () => void;
  debounceMs?: number;
}): void {
  const { enabled, channelSuffix, tables, debounceMs = 450 } = options;
  const onSignalRef = useRef(options.onSignal);
  onSignalRef.current = options.onSignal;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sig = tablesSignature(tables);

  useEffect(() => {
    if (!enabled || tables.length === 0) return;

    const supabase = createClient();
    const schedule = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        onSignalRef.current();
      }, debounceMs);
    };

    let ch = supabase.channel(`realtime:${channelSuffix}`);
    for (const t of tables) {
      const schema = t.schema ?? 'public';
      const event = t.event ?? '*';
      ch = ch.on('postgres_changes', { event, schema, table: t.table }, () => {
        schedule();
      });
    }

    ch.subscribe();

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      void supabase.removeChannel(ch);
    };
  }, [enabled, channelSuffix, debounceMs, sig, tables]);
}
