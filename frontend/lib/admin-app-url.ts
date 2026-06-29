/** Base URL of the standalone platform admin app (separate Vercel project). */
function normalizeOrigin(raw: string | undefined): string {
  const t = raw?.trim().replace(/\/$/, '') ?? '';
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  const isLocal = /^(localhost|127\.0\.0\.1)(\:|$)/i.test(t);
  return `${isLocal ? 'http' : 'https'}://${t}`;
}

/** Resolve a path on the platform admin deployment. */
export function adminAppUrl(path = '/'): string {
  const base =
    normalizeOrigin(process.env.NEXT_PUBLIC_ADMIN_APP_URL) ||
    (typeof window !== 'undefined' && window.location.hostname === 'localhost'
      ? 'http://localhost:3002'
      : '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!base) return p;
  return `${base}${p}`;
}

/** Full-page redirect to the standalone admin app (client only). */
export function redirectToAdminApp(path = '/'): void {
  if (typeof window === 'undefined') return;
  window.location.assign(adminAppUrl(path));
}
