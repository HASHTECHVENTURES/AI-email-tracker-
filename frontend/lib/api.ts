/** Ensures fetch() gets an absolute URL. Host-only values (no scheme) resolve as paths on the current origin and break production. */
function normalizeApiOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const t = raw.trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  const isLocal = /^(localhost|127\.0\.0\.1)(\:|$)/i.test(t);
  return `${isLocal ? 'http' : 'https'}://${t}`;
}

/**
 * Optional same-origin proxy (`/api-backend` → Nest) for local dev.
 *
 * **Default is off:** the browser calls `NEXT_PUBLIC_API_URL` directly (e.g. http://localhost:3000). CORS on the API
 * allows any localhost port. Long requests (Historical Search, etc.) often **time out** when forced through
 * Next.js rewrites, which surfaces as 502/504 and the generic "Server issue" banner.
 *
 * Set `NEXT_PUBLIC_USE_LOCAL_API_PROXY=1` only if you need the old same-origin behavior (e.g. a broken CORS setup).
 */
function shouldUseLocalDevProxy(): boolean {
  if (process.env.NEXT_PUBLIC_USE_LOCAL_API_PROXY !== '1') return false;
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1') return false;
  const port = window.location.port;
  if (port === '3000') return false;
  const api =
    normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL) ??
    normalizeApiOrigin(process.env.NEXT_PUBLIC_BACKEND_URL) ??
    'http://localhost:3000';
  try {
    const u = new URL(api);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Resolved URL for API requests (absolute to Nest, or same-origin `/api-backend` in local dev). */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (shouldUseLocalDevProxy()) {
    return `/api-backend${p}`;
  }
  const base =
    normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL) ??
    normalizeApiOrigin(process.env.NEXT_PUBLIC_BACKEND_URL) ??
    'http://localhost:3000';
  return `${base}${p}`;
}

/** Active team for department managers (HEAD). Sent on API requests when set in localStorage. */
export const MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY = 'manager_active_department_id';

/**
 * When set to `1`, department managers with a linked mailbox scope API calls like the employee portal
 * (`x-act-as-employee: 1`) on allowed routes only — see `actAsEmployeeHeader`.
 */
export const ACT_AS_EMPLOYEE_STORAGE_KEY = 'ai_et_act_as_employee_v1';

function managerDepartmentHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const v = localStorage.getItem(MANAGER_ACTIVE_DEPARTMENT_STORAGE_KEY)?.trim();
    if (!v) return {};
    return { 'x-manager-department-id': v };
  } catch {
    return {};
  }
}

/** HEAD + employee view: only on routes that should use mailbox/employee scope (not e.g. /employees POST). */
function actAsEmployeeHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    if (sessionStorage.getItem(ACT_AS_EMPLOYEE_STORAGE_KEY) !== '1') return {};
    const p = window.location.pathname;
    const allowed =
      p === '/dashboard' ||
      p === '/messages' ||
      p.startsWith('/conversation/') ||
      p.startsWith('/dashboard/');
    if (!allowed) return {};
    return { 'x-act-as-employee': '1' };
  } catch {
    return {};
  }
}

export function readActAsEmployeeViewEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(ACT_AS_EMPLOYEE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Toggle mailbox (employee) view for department managers with a linked employee row. */
export function setActAsEmployeeView(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      sessionStorage.setItem(ACT_AS_EMPLOYEE_STORAGE_KEY, '1');
    } else {
      sessionStorage.removeItem(ACT_AS_EMPLOYEE_STORAGE_KEY);
    }
    window.dispatchEvent(new Event('ai-et-act-as-changed'));
  } catch {
    /* ignore */
  }
}

export function apiBase(): string {
  if (typeof window !== 'undefined' && shouldUseLocalDevProxy()) {
    return `${window.location.origin}/api-backend`;
  }
  const fromEnv =
    normalizeApiOrigin(process.env.NEXT_PUBLIC_API_URL) ??
    normalizeApiOrigin(process.env.NEXT_PUBLIC_BACKEND_URL);
  return fromEnv ?? 'http://localhost:3000';
}

export async function apiFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  // Avoid 304 + stale JSON (e.g. old gemini_api_key_configured after adding GEMINI_API_KEY on the API).
  const cache = init?.cache ?? 'no-store';
  try {
    return await fetch(apiUrl(path), {
      ...init,
      cache,
      headers: {
        ...managerDepartmentHeader(),
        ...actAsEmployeeHeader(),
        ...init?.headers,
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Failed to fetch' || /network|fetch|load failed/i.test(msg)) {
      throw new Error(formatNetworkFetchFailureMessage());
    }
    throw err;
  }
}

/** Shown when fetch() throws (CORS, connection refused, mixed content, offline). */
export function formatNetworkFetchFailureMessage(): string {
  const base = apiBase();
  const isLocal =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const portClash =
    isLocal &&
    (base === 'http://localhost:3000' || base === 'http://127.0.0.1:3000') &&
    window.location.port === '3000';
  const proxyHint = isLocal
    ? ' Restart `next dev` after changing env. With NEXT_PUBLIC_USE_LOCAL_API_PROXY=1, requests use /api-backend → Nest :3000. '
    : ' ';
  const monorepoHint =
    isLocal && !portClash
      ? ' From the repo root, `npm run dev` starts Nest on :3000 and Next on :3001. If you only start the frontend, run `npm run start:dev` in the backend folder in another terminal. '
      : '';
  const portHint = portClash
    ? ' This app is on port 3000 but the API URL is also :3000 — Nest cannot share that port. Run Next on 3001 (`npm run dev` in frontend/ or `npm run dev` from repo root). '
    : '';
  return (
    `Could not reach the API (${base}). Start the backend (e.g. npm run start:dev in backend/ on port 3000).${monorepoHint}${portHint}${proxyHint}` +
    `Set NEXT_PUBLIC_API_URL in .env.local to your Nest URL (e.g. http://localhost:3000). If the app is https, the API must be https too (not http://localhost).`
  );
}

/**
 * POST + Server-Sent Events (newline-delimited `data: {...}` chunks). Parses each JSON event and calls `onEvent`.
 */
export async function apiPostSse(
  path: string,
  accessToken: string,
  jsonBody: object,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = apiUrl(path);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...managerDepartmentHeader(),
        ...actAsEmployeeHeader(),
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonBody),
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {
      throw new Error(await readApiErrorMessage(res, 'Request failed.'));
    }
    if (!res.body) {
      throw new Error('No response body from server.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
            } catch {
              // ignore malformed chunk
            }
          }
        }
      }
    }
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Failed to fetch' || /network|fetch|load failed/i.test(msg)) {
      throw new Error(formatNetworkFetchFailureMessage());
    }
    throw err;
  }
}

type ApiJsonError = { message?: unknown; error?: unknown; code?: unknown };

export async function readApiErrorMessage(
  res: Response,
  fallback = 'Something went wrong. Please try again.',
): Promise<string> {
  try {
    const body = (await res.json()) as ApiJsonError;
    const msg =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : typeof body.error === 'string' && body.error.trim()
          ? body.error.trim()
          : '';
    if (msg) {
      if (
        res.status === 404 &&
        (msg.includes('Cannot GET') || msg.includes('Cannot POST')) &&
        msg.includes('self-tracking')
      ) {
        return (
          'API route missing or stale server — stop and restart the Nest backend (`npm run start:dev` in the backend folder) ' +
          'so new routes load. Ensure `NEXT_PUBLIC_API_URL` is the Nest URL (e.g. http://localhost:3000), not the Next.js port. ' +
          'After changing `.env.local`, restart `next dev` too.'
        );
      }
      return msg;
    }
  } catch {
    // non-JSON response
  }
  if (res.status === 401) return 'Your session expired. Please sign in again.';
  if (res.status === 502 || res.status === 504) {
    return (
      'The API took too long to respond (often a proxy timeout). Use a shorter date range, or call the API directly: ' +
      'set NEXT_PUBLIC_USE_LOCAL_API_PROXY unset in .env.local so the app talks to Nest on :3000 without the Next.js rewrite.'
    );
  }
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
