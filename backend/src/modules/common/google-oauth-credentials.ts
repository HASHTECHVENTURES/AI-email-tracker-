/**
 * Google OAuth env values with trim — stray whitespace in Railway/.env breaks
 * redirect_uri matching (Google returns 400 invalid_request / redirect_uri_mismatch).
 *
 * When GOOGLE_REDIRECT_URI is unset, Railway's RAILWAY_PUBLIC_DOMAIN is used so the
 * callback URL matches https://<service>.up.railway.app/auth/google/callback without
 * duplicate env configuration.
 */
function stripTrailingSlash(u: string): string {
  if (u.length <= 1) return u;
  return u.replace(/\/+$/, '');
}

export function getGoogleRedirectUri(): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim() ?? '';
  if (explicit && explicit !== 'local-dev-placeholder') {
    return stripTrailingSlash(explicit);
  }
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) {
    const host = railway.replace(/^https?:\/\//i, '').split('/')[0];
    if (host) return `https://${host}/auth/google/callback`;
  }
  return '';
}

export function getGoogleOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    redirectUri: getGoogleRedirectUri(),
  };
}
