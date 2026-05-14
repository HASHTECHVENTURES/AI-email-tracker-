import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { requirePublicSupabaseEnv } from './public-env';

export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = requirePublicSupabaseEnv(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          /* ignore when called from Server Component */
        }
      },
    },
  });
}
