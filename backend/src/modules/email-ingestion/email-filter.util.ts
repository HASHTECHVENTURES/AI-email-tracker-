import type { EmailMessage } from '../common/types';

const AUTOMATED_LOCALPART = /^(no-?reply|noreply|notifications?|mailer-daemon|bounce|donotreply|automated|system|support\+)/i;

const NOISE_SUBJECT_KEYWORDS =
  /\b(unsubscribe|newsletter|digest|promotion|sale\s*\d+%|black\s*friday|webinar recording|your order has shipped|password reset|verify your email)\b/i;

const NOISE_BODY_SNIPPET = /\b(unsubscribe|view in browser|manage preferences|you are receiving this email because)\b/i;

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
  if (domain && from.endsWith(`@${domain}`)) return false;

  return true;
}
