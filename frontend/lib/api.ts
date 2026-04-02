export function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
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
