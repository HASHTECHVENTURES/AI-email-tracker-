/** postMessage type when /auth/gmail-oauth-done closes the OAuth popup. */
export const GMAIL_OAUTH_COMPLETE_MSG = 'ai_et_gmail_oauth_complete_v1';

export type MailOAuthProvider = 'google' | 'microsoft' | 'zoho';

export type GmailOAuthCompletePayload = {
  type: typeof GMAIL_OAUTH_COMPLETE_MSG;
  next: string;
  connected: boolean;
  employee_id: string | null;
  provider?: MailOAuthProvider | null;
  oauth_error?: string | null;
};

function isMicrosoftAuthorizeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('login.microsoftonline.com') || host.includes('login.live.com');
  } catch {
    return /login\.microsoftonline\.com|login\.live\.com/i.test(url);
  }
}

function isGoogleAuthorizeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('accounts.google.com');
  } catch {
    return /accounts\.google\.com/i.test(url);
  }
}

function isZohoAuthorizeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('accounts.zoho.');
  } catch {
    return /accounts\.zoho\./i.test(url);
  }
}

/** Open OAuth in a popup so the main app tab keeps the Supabase session. Falls back to full navigation if popups are blocked. */
export function openMailOAuthWindow(
  authorizeUrl: string,
  provider: MailOAuthProvider,
): Window | null {
  if (typeof window === 'undefined') return null;

  if (provider === 'microsoft' && !isMicrosoftAuthorizeUrl(authorizeUrl)) {
    throw new Error('Expected a Microsoft login URL from the server.');
  }
  if (provider === 'google' && !isGoogleAuthorizeUrl(authorizeUrl)) {
    throw new Error('Expected a Google login URL from the server.');
  }
  if (provider === 'zoho' && !isZohoAuthorizeUrl(authorizeUrl)) {
    throw new Error('Expected a Zoho login URL from the server.');
  }

  const windowName =
    provider === 'microsoft'
      ? 'microsoft_oauth'
      : provider === 'zoho'
        ? 'zoho_oauth'
        : 'gmail_oauth';
  const w = window.open(
    authorizeUrl,
    windowName,
    'popup=yes,width=560,height=720,left=80,top=48,scrollbars=yes,resizable=yes',
  );
  if (!w) {
    window.location.assign(authorizeUrl);
    return null;
  }
  try {
    w.focus();
  } catch {
    /* ignore */
  }
  return w;
}

/** @deprecated Use {@link openMailOAuthWindow} with provider `google`. */
export function openGmailOAuthWindow(authorizeUrl: string): Window | null {
  return openMailOAuthWindow(authorizeUrl, 'google');
}

export function mailOAuthSuccessMessage(provider?: MailOAuthProvider | null): string {
  if (provider === 'microsoft') return 'Outlook connected successfully.';
  if (provider === 'zoho') return 'Zoho Mail connected successfully.';
  return 'Gmail connected successfully.';
}

/** Turn raw OAuth / sync token errors into actionable copy for the UI. */
export function humanizeMailSyncError(message: string | null | undefined): string {
  const msg = (message ?? '').trim();
  if (!msg) return 'Something went wrong.';
  if (/invalid_grant/i.test(msg)) {
    return 'Mail access expired or tokens got mixed up. Reconnect your mailbox (Gmail, Outlook, or Zoho) on the mailbox card.';
  }
  if (/token refresh failed/i.test(msg)) {
    return 'Could not refresh mail access. Reconnect your mailbox, then press Sync now.';
  }
  return msg;
}

export function subscribeGmailOAuthComplete(
  onDone: (payload: Omit<GmailOAuthCompletePayload, 'type'>) => void,
): () => void {
  const fn = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data as Partial<GmailOAuthCompletePayload>;
    if (d?.type !== GMAIL_OAUTH_COMPLETE_MSG) return;
    onDone({
      next: typeof d.next === 'string' && d.next.startsWith('/') ? d.next : '/my-email',
      connected: d.connected === true,
      employee_id: typeof d.employee_id === 'string' ? d.employee_id : null,
      provider:
        d.provider === 'microsoft' || d.provider === 'google' || d.provider === 'zoho'
          ? d.provider
          : null,
      oauth_error: typeof d.oauth_error === 'string' ? d.oauth_error : null,
    });
  };
  window.addEventListener('message', fn);
  return () => window.removeEventListener('message', fn);
}
