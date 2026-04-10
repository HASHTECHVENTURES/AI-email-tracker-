/** postMessage type when /auth/gmail-oauth-done closes the OAuth popup. */
export const GMAIL_OAUTH_COMPLETE_MSG = 'ai_et_gmail_oauth_complete_v1';

export type GmailOAuthCompletePayload = {
  type: typeof GMAIL_OAUTH_COMPLETE_MSG;
  next: string;
  connected: boolean;
  employee_id: string | null;
};

/** Open Google OAuth in a popup so the main app tab keeps the Supabase session. Falls back to full navigation if popups are blocked. */
export function openGmailOAuthWindow(authorizeUrl: string): Window | null {
  if (typeof window === 'undefined') return null;
  const w = window.open(
    authorizeUrl,
    'gmail_oauth',
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
    });
  };
  window.addEventListener('message', fn);
  return () => window.removeEventListener('message', fn);
}
