function stripTrailingSlash(u: string): string {
  if (u.length <= 1) return u;
  return u.replace(/\/+$/, '');
}

export function getMicrosoftRedirectUri(): string {
  const explicit = process.env.MICROSOFT_REDIRECT_URI?.trim() ?? '';
  if (explicit) {
    return stripTrailingSlash(explicit);
  }
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) {
    const host = railway.replace(/^https?:\/\//i, '').split('/')[0];
    if (host) return `https://${host}/auth/microsoft/callback`;
  }
  return '';
}

export function getMicrosoftOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenantId: string;
} {
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET?.trim() ?? '',
    redirectUri: getMicrosoftRedirectUri(),
    tenantId: process.env.MICROSOFT_TENANT_ID?.trim() || 'common',
  };
}

export function isMicrosoftOAuthConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getMicrosoftOAuthCredentials();
  const invalid = new Set(['', 'local-dev-placeholder']);
  return (
    !invalid.has(clientId) &&
    !invalid.has(clientSecret) &&
    redirectUri.length > 0
  );
}

/** Microsoft Graph delegated scopes for inbox sync. */
export const MICROSOFT_MAIL_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.Read',
];

export function buildMicrosoftAuthorizeUrl(state: string): string {
  const { clientId, redirectUri, tenantId } = getMicrosoftOAuthCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_MAIL_SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}
