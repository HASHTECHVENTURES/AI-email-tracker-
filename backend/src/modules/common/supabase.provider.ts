import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_CLIENT = 'SUPABASE_CLIENT';

export const supabaseProvider = {
  provide: SUPABASE_CLIENT,
  useFactory: (): SupabaseClient => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
    }

    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  },
};
