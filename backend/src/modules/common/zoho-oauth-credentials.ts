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

/** Map Zoho OAuth `location` callback param (e.g. `in`, `eu`) to accounts server URL. */
export function accountsServerFromLocation(location: string | undefined): string | null {
  const loc = location?.trim().toLowerCase();
  if (!loc) return null;
  const map: Record<string, string> = {
    in: 'https://accounts.zoho.in',
    us: 'https://accounts.zoho.com',
    com: 'https://accounts.zoho.com',
    eu: 'https://accounts.zoho.eu',
    au: 'https://accounts.zoho.com.au',
    jp: 'https://accounts.zoho.jp',
    uk: 'https://accounts.zoho.uk',
    ca: 'https://accounts.zohocloud.ca',
    sa: 'https://accounts.zoho.sa',
  };
  return map[loc] ?? null;
}

/** Map token `api_domain` (e.g. https://www.zohoapis.in) to Zoho Mail API host. */
export function mailApiBaseFromApiDomain(apiDomain: string | undefined): string | null {
  const host = apiDomain?.trim().toLowerCase() ?? '';
  if (!host) return null;
  if (host.includes('zoho.in') || host.includes('zohoapis.in')) return 'https://mail.zoho.in';
  if (host.includes('zoho.eu') || host.includes('zohoapis.eu')) return 'https://mail.zoho.eu';
  if (host.includes('zoho.com.au') || host.includes('zohoapis.com.au')) {
    return 'https://mail.zoho.com.au';
  }
  if (host.includes('zoho.jp') || host.includes('zohoapis.jp')) return 'https://mail.zoho.jp';
  if (host.includes('zoho.uk') || host.includes('zohoapis.uk')) return 'https://mail.zoho.uk';
  if (host.includes('zohocloud.ca') || host.includes('zohoapis.ca')) {
    return 'https://mail.zoho.com';
  }
  if (host.includes('zoho.sa') || host.includes('zohoapis.sa')) return 'https://mail.zoho.com';
  if (host.includes('zoho.com') || host.includes('zohoapis.com')) return 'https://mail.zoho.com';
  return null;
}

export function mailApiBaseFromAccountsServer(accountsServer: string): string {
  const host = accountsServer.toLowerCase();
  if (host.includes('zoho.in')) return 'https://mail.zoho.in';
  if (host.includes('zoho.eu')) return 'https://mail.zoho.eu';
  if (host.includes('zoho.com.au')) return 'https://mail.zoho.com.au';
  if (host.includes('zoho.jp')) return 'https://mail.zoho.jp';
  if (host.includes('zoho.uk')) return 'https://mail.zoho.uk';
  if (host.includes('zohocloud.ca')) return 'https://mail.zoho.com';
  if (host.includes('zoho.sa')) return 'https://mail.zoho.com';
  const fromEnv = process.env.ZOHO_MAIL_API_BASE?.trim();
  if (fromEnv && host.includes('zoho.in')) return stripTrailingSlash(fromEnv);
  return 'https://mail.zoho.com';
}

/** Prefer OAuth token `api_domain`, then accounts server DC; env override only for India. */
export function resolveZohoMailApiBase(
  accountsServer: string,
  apiDomain?: string | null,
): string {
  return (
    mailApiBaseFromApiDomain(apiDomain ?? undefined) ??
    mailApiBaseFromAccountsServer(accountsServer)
  );
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
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Zoho token exchange failed (${res.status})`);
  }
  if (!data.access_token) {
    throw new Error('Zoho token exchange returned no access_token');
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
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Zoho token exchange failed (${res.status})`);
  }
  if (!data.access_token) {
    throw new Error('Zoho token exchange returned no access_token');
  }
  return data;
}

type ZohoEmailAddressEntry = {
  mailId?: string;
  isPrimary?: boolean;
};

type ZohoAccountRow = {
  accountId?: string;
  emailAddress?: string | ZohoEmailAddressEntry[];
  primaryEmailAddress?: string;
  mailId?: string;
  incomingUserName?: string;
  mailboxAddress?: string;
};

function zohoRowEmails(row: ZohoAccountRow): string[] {
  const emails: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (t) emails.push(t);
    }
  };
  push(row.primaryEmailAddress);
  push(row.mailId);
  push(row.incomingUserName);
  push(row.mailboxAddress);
  const ea = row.emailAddress;
  if (typeof ea === 'string') {
    push(ea);
  } else if (Array.isArray(ea)) {
    for (const entry of ea) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') push(entry.mailId);
    }
  }
  return [...new Set(emails)];
}

/** Map backend Zoho OAuth failures to stable `oauth_error` query codes for the UI. */
export function zohoOAuthErrorCode(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err ?? '');
  if (/missing_refresh_token/i.test(msg)) return 'missing_refresh_token';
  if (/Zoho accounts list failed/i.test(msg)) return 'zoho_accounts_failed';
  if (/Could not resolve Zoho Mail account/i.test(msg)) return 'zoho_account_mismatch';
  if (/invalid_grant|invalid_code/i.test(msg)) return 'invalid_grant';
  return 'exchange_failed';
}

export async function resolveZohoOAuthMeta(
  accessToken: string,
  employeeEmail: string,
  accountsServer: string,
  apiDomain?: string | null,
): Promise<ZohoOAuthMeta> {
  const mailApiBase = resolveZohoMailApiBase(accountsServer, apiDomain);
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
    (norm ? rows.find((r) => zohoRowEmails(r).includes(norm)) : undefined) ?? rows[0];
  const accountId = match?.accountId?.trim();
  if (!accountId) {
    throw new Error('Could not resolve Zoho Mail account for this mailbox email.');
  }
  return { accountsServer: stripTrailingSlash(accountsServer), mailApiBase, accountId };
}
