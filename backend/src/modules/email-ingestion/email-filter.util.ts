import type { EmailMessage } from '../common/types';

const AUTOMATED_LOCALPART = /^(no-?reply|noreply|notifications?|mailer-daemon|bounce|donotreply|automated|system|support\+)/i;

const NOISE_SUBJECT_KEYWORDS =
  /\b(unsubscribe|newsletter|digest|promotion|sale\s*\d+%|black\s*friday|webinar recording|your order has shipped|password reset|verify your email)\b/i;

const NOISE_BODY_SNIPPET = /\b(unsubscribe|view in browser|manage preferences|you are receiving this email because)\b/i;

/** Shared public inbox domains — do not treat "same domain" as same company (e.g. two @gmail.com users). */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

/**
 * Heuristic filter: skip bulk / automated mail so follow-up tracking stays human-to-human.
 */
export function isRelevantEmail(
  message: EmailMessage,
  employeeEmail: string,
  excludePatterns: string[],
  hasNoiseGmailLabel: boolean,
): boolean {
  if (hasNoiseGmailLabel) return false;

  const from = message.fromEmail.toLowerCase();
  const local = from.split('@')[0] ?? '';
  if (AUTOMATED_LOCALPART.test(local)) return false;

  for (const p of excludePatterns) {
    if (p && from.includes(p.toLowerCase())) return false;
  }

  const subject = (message.subject ?? '').toLowerCase();
  const body = (message.bodyText ?? '').slice(0, 2000).toLowerCase();
  if (NOISE_SUBJECT_KEYWORDS.test(subject) || NOISE_BODY_SNIPPET.test(body)) return false;

  const domain = employeeEmail.split('@')[1]?.toLowerCase() ?? '';
  // Skip colleague@acme.com → employee@acme.com; but allow client@gmail.com → tracked@gmail.com.
  if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain) && from.endsWith(`@${domain}`)) return false;

  return true;
}
