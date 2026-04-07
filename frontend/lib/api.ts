/** Ensures fetch() gets an absolute URL. Host-only values (no scheme) resolve as paths on the current origin and break production. */
function normalizeApiOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const t = raw.trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  const isLocal = /^(localhost|127\.0\.0\.1)(\:|$)/i.test(t);
  return `${isLocal ? 'http' : 'https'}://${t}`;
}

export function apiBase(): string {
  const fromEnv =
    normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL) ??
    normalizeApiOrigin(process.env.NEXT_PUBLIC_BACKEND_URL);
  return fromEnv ?? 'http://localhost:3000';
}

export async function apiFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase()}${path.startsWith('/') ? path : `/${path}`}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

type ApiJsonError = { message?: unknown; error?: unknown; code?: unknown };

export async function readApiErrorMessage(
  res: Response,
  fallback = 'Something went wrong. Please try again.',
): Promise<string> {
  try {
    const body = (await res.json()) as ApiJsonError;
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // non-JSON response
  }
  if (res.status === 401) return 'Your session expired. Please sign in again.';
  if (res.status >= 500) return 'Server issue. Please try again in a moment.';
  return fallback;
}

export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    exchange_failed: 'Could not complete Google connection. Please try again.',
    access_denied: 'Google sign-in was cancelled.',
    not_configured: 'Google connection is not configured yet.',
    missing_code_or_state: 'Google returned an invalid sign-in response. Please retry.',
  };
  return map[code] ?? 'Google connection failed. Please try again.';
}
