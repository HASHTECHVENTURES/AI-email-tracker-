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
