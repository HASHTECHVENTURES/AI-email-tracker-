import type { Session, SupabaseClient } from '@supabase/supabase-js';

/** True when Supabase Auth cookies reference a refresh token that no longer exists server-side. */
export function isStaleRefreshTokenError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: string; code?: string; status?: number };
  const msg = (e.message ?? '').toLowerCase();
  const code = (e.code ?? '').toLowerCase();
  return (
    code === 'refresh_token_not_found' ||
    msg.includes('refresh token not found') ||
    msg.includes('invalid refresh token')
  );
}

/**
 * Reads the browser session and clears local auth storage when refresh tokens are dead.
 * Prevents repeated 400s on `/token?grant_type=refresh_token` after logout or user deletion.
 */
export async function getBrowserSession(
  supabase: SupabaseClient,
): Promise<{ session: Session | null; clearedStale: boolean }> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    if (isStaleRefreshTokenError(error)) {
      await supabase.auth.signOut();
      return { session: null, clearedStale: true };
    }
    throw error;
  }
  return { session: data.session, clearedStale: false };
}
