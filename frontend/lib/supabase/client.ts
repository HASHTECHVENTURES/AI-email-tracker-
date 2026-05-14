import { createBrowserClient } from '@supabase/ssr';
import { requirePublicSupabaseEnv } from './public-env';

export function createClient() {
  const { url, key } = requirePublicSupabaseEnv(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return createBrowserClient(url, key);
}
