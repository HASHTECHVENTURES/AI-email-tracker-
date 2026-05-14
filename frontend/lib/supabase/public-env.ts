/**
 * Validates public Supabase env before any network call so misconfigured local
 * `.env.local` fails with an actionable message instead of ERR_NAME_NOT_RESOLVED / "Failed to fetch".
 */
export function requirePublicSupabaseEnv(
  url: string | undefined,
  key: string | undefined,
): { url: string; key: string } {
  if (!url?.trim() || !key?.trim()) {
    throw new Error(
      'Missing Supabase settings. In frontend/.env.local set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (copy from Supabase → Project Settings → API), then restart `next dev`.',
    );
  }

  const u = url.trim();
  const k = key.trim();

  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL must use https. Use the URL from Supabase → Project Settings → API.',
      );
    }
    const host = parsed.hostname.toLowerCase();
    if (host.includes('your-project-ref') || host.includes('your_project_ref')) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL is still the template value. Replace `your-project-ref` with your real project ref (Supabase → Project Settings → API → Project URL), then restart `next dev`.',
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('NEXT_PUBLIC_SUPABASE_URL')) {
      throw e;
    }
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not a valid URL. Copy the Project URL from Supabase → Project Settings → API into frontend/.env.local.',
    );
  }

  if (/^(your_anon_key|your-anon-key)$/i.test(k) || k === 'YOUR_SUPABASE_ANON_PUBLIC_KEY') {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY is still a placeholder. Paste the anon (public) key from Supabase → Project Settings → API into frontend/.env.local, then restart `next dev`.',
    );
  }

  return { url: u, key: k };
}

/** Maps thrown config errors and common fetch failures to UI copy. */
export function formatAuthClientError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message;
    if (
      m.includes('NEXT_PUBLIC_SUPABASE') ||
      m.includes('Supabase settings') ||
      m.includes('template value') ||
      m.includes('placeholder')
    ) {
      return m;
    }
    if (m === 'Failed to fetch' || m.includes('NetworkError') || m.includes('Load failed')) {
      return 'Could not reach Supabase. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in frontend/.env.local (must match Supabase → Project Settings → API), restart `next dev`, and confirm you are online.';
    }
    return m;
  }
  return 'Something went wrong. Please try again.';
}
