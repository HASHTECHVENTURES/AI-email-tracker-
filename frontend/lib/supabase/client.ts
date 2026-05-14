import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePublicSupabaseEnv } from './public-env';

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
  const client = createBrowserClient(url, key);
  if (typeof window !== 'undefined') {
    browserClient = client;
  }
  return client;
}
