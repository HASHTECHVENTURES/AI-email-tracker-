function stripTrailingSlash(u: string): string {
  if (u.length <= 1) return u;
  return u.replace(/\/+$/, '');
}

export const ZOHO_MAIL_SCOPES =
  'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ';

export type ZohoOAuthMeta = {
  accountsServer: string;
  mailApiBase: string;
  accountId: string;
  inboxFolderId?: string;
  sentFolderId?: string;
};

export function getZohoRedirectUri(): string {
  const explicit = process.env.ZOHO_REDIRECT_URI?.trim() ?? '';
  if (explicit) return stripTrailingSlash(explicit);
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) {
    const host = railway.replace(/^https?:\/\//i, '').split('/')[0];
    if (host) return `https://${host}/auth/zoho/callback`;
  }
  return '';
}

export function getZohoAccountsServer(): string {
  return stripTrailingSlash(
    process.env.ZOHO_ACCOUNTS_SERVER?.trim() || 'https://accounts.zoho.in',
  );
}

export function mailApiBaseFromAccountsServer(accountsServer: string): string {
  const fromEnv = process.env.ZOHO_MAIL_API_BASE?.trim();
  if (fromEnv) return stripTrailingSlash(fromEnv);
  const host = accountsServer.toLowerCase();
  if (host.includes('zoho.in')) return 'https://mail.zoho.in';
  if (host.includes('zoho.eu')) return 'https://mail.zoho.eu';
  if (host.includes('zoho.com.au')) return 'https://mail.zoho.com.au';
  if (host.includes('zoho.jp')) return 'https://mail.zoho.jp';
  return 'https://mail.zoho.com';
}

export function getZohoOAuthCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  return {
    clientId: process.env.ZOHO_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET?.trim() ?? '',
    redirectUri: getZohoRedirectUri(),
  };
}

export function isZohoOAuthConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getZohoOAuthCredentials();
  const invalid = new Set(['', 'local-dev-placeholder']);
  return (
    !invalid.has(clientId) &&
    !invalid.has(clientSecret) &&
    redirectUri.length > 0
  );
}

export function buildZohoAuthorizeUrl(state: string, accountsServer?: string): string {
  const { clientId, redirectUri } = getZohoOAuthCredentials();
  const base = stripTrailingSlash(accountsServer || getZohoAccountsServer());
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: ZOHO_MAIL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${base}/oauth/v2/auth?${params.toString()}`;
}

export type ZohoTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  api_domain?: string;
  token_type?: string;
  error?: string;
};

export async function exchangeZohoAuthorizationCode(
  code: string,
  accountsServer: string,
): Promise<ZohoTokenResponse> {
  const { clientId, clientSecret, redirectUri } = getZohoOAuthCredentials();
  const base = stripTrailingSlash(accountsServer);
  const body = new URLSearchParams({
    code: code.trim(),
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${base}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as ZohoTokenResponse;
  if (!res.ok) {
    throw new Error(data.error ?? (await res.text()));
  }
  return data;
}

export async function refreshZohoAccessToken(
  refreshToken: string,
  accountsServer: string,
): Promise<ZohoTokenResponse> {
  const { clientId, clientSecret } = getZohoOAuthCredentials();
  const base = stripTrailingSlash(accountsServer);
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${base}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as ZohoTokenResponse;
  if (!res.ok) {
    throw new Error(data.error ?? (await res.text()));
  }
  return data;
}

type ZohoAccountRow = {
  accountId?: string;
  emailAddress?: string;
  primaryEmailAddress?: string;
  mailId?: string;
};

export async function resolveZohoOAuthMeta(
  accessToken: string,
  employeeEmail: string,
  accountsServer: string,
): Promise<ZohoOAuthMeta> {
  const mailApiBase = mailApiBaseFromAccountsServer(accountsServer);
  const res = await fetch(`${mailApiBase}/api/accounts`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Zoho accounts list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: ZohoAccountRow[] };
  const norm = employeeEmail.trim().toLowerCase();
  const rows = body.data ?? [];
  const match =
    rows.find((r) => (r.emailAddress ?? r.primaryEmailAddress ?? r.mailId ?? '').trim().toLowerCase() === norm) ??
    rows[0];
  const accountId = match?.accountId?.trim();
  if (!accountId) {
    throw new Error('Could not resolve Zoho Mail account for this mailbox email.');
  }
  return { accountsServer: stripTrailingSlash(accountsServer), mailApiBase, accountId };
}
