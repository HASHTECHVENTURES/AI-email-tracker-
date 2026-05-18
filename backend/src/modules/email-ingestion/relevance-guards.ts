import type { EmailMessage } from '../common/types';

/** Minimal fields for noise heuristics (ingest + conversation recompute). */
export type InboundNoiseFields = {
  direction?: string;
  from_email?: string;
  fromEmail?: string;
  subject?: string | null;
  body_text?: string | null;
  bodyText?: string | null;
};

function readInboundFields(msg: InboundNoiseFields): {
  from: string;
  subject: string;
  body: string;
} {
  return {
    from: (msg.from_email ?? msg.fromEmail ?? '').trim().toLowerCase(),
    subject: (msg.subject ?? '').trim(),
    body: ((msg.body_text ?? msg.bodyText) ?? '').slice(0, 6_000),
  };
}

/** Google/Outlook calendar invites, updates, and accept/decline/tentative RSVPs. */
export function looksLikeCalendarNotification(msg: InboundNoiseFields): boolean {
  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase();

  if (
    /calendar-notification@google\.com|@resource\.calendar\.google|group\.calendar\.google|outlook\.com$/i.test(
      from,
    ) ||
    /@calendar\.google/i.test(from)
  ) {
    return true;
  }

  const subjectHit =
    /^invitation\b/i.test(sub) ||
    /^(accepted|declined|tentative|canceled|cancelled|updated invitation|invitation):\s/i.test(
      sub,
    ) ||
    /\bhas accepted your invitation\b/i.test(sub) ||
    /\bhas declined your invitation\b/i.test(sub) ||
    /\bhas tentatively accepted\b/i.test(sub) ||
    /\baccepted an invitation\b/i.test(sub) ||
    /\bcalendar invitation\b/i.test(sub) ||
    /\bevent (updated|cancelled|canceled)\b/i.test(sub);

  const bodyHit =
    /begin:vcalendar/i.test(b) ||
    /content-type:\s*text\/calendar/i.test(b) ||
    /\bhas accepted your invitation\b/i.test(b) ||
    /\bhas declined your invitation\b/i.test(b) ||
    /\bhas tentatively accepted\b/i.test(b) ||
    /view on google calendar/i.test(b) ||
    /invitation from google calendar/i.test(b) ||
    /rsvp to this event/i.test(b) ||
    /organizer:\s*\S+@/i.test(b);

  return subjectHit || bodyHit;
}

/** Marketing / promo / newsletter-style mail (Gmail Promotions label is a strong signal). */
export function looksLikePromotionalMail(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel = false,
): boolean {
  if (hasNoiseGmailLabel) return true;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase();

  if (
    /^(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster|marketing|newsletter|promotions?|deals?|offers?)@/i.test(
      from,
    )
  ) {
    return true;
  }

  if (
    /(newsletter|digest|unsubscribe|promo|promotion|campaign|webinar|view in browser|flash sale|limited time offer|\d+%\s*off|save \d+%|coupon|promo code|free shipping|shop now|exclusive deal)/i.test(
      sub,
    )
  ) {
    return true;
  }

  if (
    /(unsubscribe|manage preferences|view in browser|email preferences|opt out|you are receiving this (email )?because)/i.test(
      b,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Inbound promotional/newsletter mail — excluded from Need reply and auto-skipped at ingest.
 * Calendar invites and meeting events are NOT noise; they belong in Need reply when unanswered.
 */
export function looksLikeInboundNoReplyNoise(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel = false,
): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  return looksLikePromotionalMail(msg, hasNoiseGmailLabel);
}

/** Hard skip at ingest for promotional noise only (not calendar/events). */
export function ingestSkipReasonForInboundNoise(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel: boolean,
): string | null {
  if (!looksLikeInboundNoReplyNoise(msg, hasNoiseGmailLabel)) return null;
  return 'Promotional or marketing mail — not a customer reply thread.';
}

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
  if (looksLikeInboundNoReplyNoise(target, hasNoiseGmailLabel)) return false;

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
