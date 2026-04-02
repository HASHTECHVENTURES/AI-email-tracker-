export function apiBase(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ??
    process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '');
  const base = fromEnv ?? 'http://localhost:3000';
  return base;
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
