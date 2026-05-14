import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePublicSupabaseEnv } from './public-env';

const SUPABASE_FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort();
  try {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

/**
 * One browser client for the whole app. Multiple instances each run token refresh
 * and trip gotrue-js storage locks (especially with React Strict Mode), which shows
 * up as 504s on `/token` and `AuthRetryableFetchError` in the console.
 */
let browserClient: SupabaseClient | undefined;

export function createClient(): SupabaseClient {
  if (typeof window !== 'undefined' && browserClient) {
    return browserClient;
  }
  const { url, key } = requirePublicSupabaseEnv(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const client = createBrowserClient(url, key, {
    global: {
      fetch: typeof window === 'undefined' ? fetch : fetchWithTimeout,
    },
  });
  if (typeof window !== 'undefined') {
    browserClient = client;
  }
  return client;
}
