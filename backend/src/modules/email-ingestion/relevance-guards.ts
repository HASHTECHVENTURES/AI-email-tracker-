import type { EmailMessage } from '../common/types';

/**
 * Guardrail for false negatives: if Inbox AI says "irrelevant" but this looks like
 * a direct human thread to the tracked mailbox, keep it in the portal.
 * Shared by live ingestion and historical backfill.
 */
export function looksLikeDirectHumanMail(
  target: EmailMessage,
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
): boolean {
  if (target.direction !== 'INBOUND') return false;
  if (hasNoiseGmailLabel) return false;

  const norm = (v: string) => v.trim().toLowerCase();
  const mailbox = norm(employeeEmail);
  const to = (target.toEmails ?? []).map(norm).filter(Boolean);
  const cc = (target.ccEmails ?? []).map(norm).filter(Boolean);
  const recipients = new Set([...to, ...cc]);
  const isDirectToMailbox = to.includes(mailbox) || cc.includes(mailbox);
  const isSmallAudience = recipients.size <= 8;

  const from = norm(target.fromEmail ?? '');
  const subject = (target.subject ?? '').toLowerCase();
  const body = (target.bodyText ?? '').slice(0, 2000).toLowerCase();

  const automatedSender = /(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster)/i.test(from);
  const obviousBroadcastSubject =
    /(newsletter|digest|unsubscribe|promo|promotion|campaign|webinar|view in browser)/i.test(subject);
  const obviousBroadcastBody =
    /(unsubscribe|manage preferences|view in browser|email preferences)/i.test(body);

  if (!isDirectToMailbox || !isSmallAudience) return false;
  if (automatedSender || obviousBroadcastSubject || obviousBroadcastBody) return false;
  return true;
}
