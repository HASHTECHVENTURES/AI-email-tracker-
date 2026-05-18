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

/**
 * Calendar invites & meeting events from any sender (not only marketing@).
 * Covers Gmail "Invitation: … @ Mon May 18, 2026 5pm", Fireflies prep, ICS bodies, etc.
 */
export function looksLikeMeetingOrEventMail(msg: InboundNoiseFields): boolean {
  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase();
  const combined = `${sub} ${b}`;

  if (
    /calendar-notification@google\.com|@resource\.calendar\.google|group\.calendar\.google/i.test(
      from,
    ) ||
    /@calendar\.google/i.test(from)
  ) {
    return true;
  }

  if (
    /@(?:fireflies\.ai|calendly\.com|zoom\.us|calendar\.google\.com)\b/i.test(from) &&
    /(meeting|invite|invitation|scheduled|calendar|prep)/i.test(combined)
  ) {
    return true;
  }

  const subjectHit =
    /^invitation\b/i.test(sub) ||
    /^invitation:/i.test(sub) ||
    /^meeting prep:/i.test(sub) ||
    /^updated invitation:/i.test(sub) ||
    /\binvitation:\s+.+\s@\s+(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(sub) ||
    /\s@\s+(?:mon|tue|wed|thu|fri|sat|sun)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i.test(
      sub,
    ) ||
    /^(accepted|declined|tentative|canceled|cancelled|updated invitation|invitation):\s/i.test(
      sub,
    ) ||
    /\bhas accepted your invitation\b/i.test(sub) ||
    /\bhas declined your invitation\b/i.test(sub) ||
    /\bhas tentatively accepted\b/i.test(sub) ||
    /\baccepted an invitation\b/i.test(sub) ||
    /\bcalendar invitation\b/i.test(sub) ||
    /\bevent (updated|cancelled|canceled)\b/i.test(sub) ||
    /\bmeeting (update|reminder|scheduled|cancelled|canceled|prep)\b/i.test(sub) ||
    (/\binvitation\b/i.test(sub) && /\d{1,2}:\d{2}\s*(?:am|pm)?/i.test(sub) && /\d{4}/.test(sub));

  const bodyHit =
    /begin:vcalendar/i.test(b) ||
    /content-type:\s*text\/calendar/i.test(b) ||
    /\bmethod:\s*request\b/i.test(b) ||
    /\bvevent\b/i.test(b) ||
    /\bhas accepted your invitation\b/i.test(b) ||
    /\bhas declined your invitation\b/i.test(b) ||
    /\bhas tentatively accepted\b/i.test(b) ||
    /view on google calendar/i.test(b) ||
    /invitation from google calendar/i.test(b) ||
    /rsvp to this event/i.test(b) ||
    /organizer:\s*\S+@/i.test(b) ||
    /https?:\/\/[^\s]*meet\.google\.com/i.test(b) ||
    /https?:\/\/[^\s]*zoom\.us\/(?:j|my)\//i.test(b) ||
    /https?:\/\/[^\s]*teams\.microsoft\.com/i.test(b) ||
    /\bwhen:\s*.{3,120}/i.test(b) ||
    /\bwhere:\s*.{3,120}/i.test(b) ||
    /\bhas invited you to\b/i.test(b) ||
    /\byou have been invited\b/i.test(b);

  return subjectHit || bodyHit;
}

/** @deprecated Use looksLikeMeetingOrEventMail — kept for existing imports. */
export function looksLikeCalendarNotification(msg: InboundNoiseFields): boolean {
  return looksLikeMeetingOrEventMail(msg);
}

/** Marketing / promo / newsletter-style mail (Gmail Promotions label is a strong signal). */
export function looksLikePromotionalMail(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel = false,
): boolean {
  if (looksLikeMeetingOrEventMail(msg)) return false;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase();

  if (hasNoiseGmailLabel) return true;

  if (
    /^(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster|newsletter|promotions?|deals?|offers?)@/i.test(
      from,
    )
  ) {
    return true;
  }
  if (/^marketing@/i.test(from)) {
    return (
      /(newsletter|unsubscribe|promo|promotion|campaign|webinar|view in browser|flash sale)/i.test(sub) ||
      /(unsubscribe|manage preferences|view in browser)/i.test(b)
    );
  }

  if (
    /(newsletter|digest|unsubscribe|promo code|promotion|campaign|webinar|view in browser|flash sale|limited time offer|\d+%\s*off|save \d+%|coupon|free shipping|shop now|exclusive deal)/i.test(
      sub,
    )
  ) {
    return true;
  }

  if (
    /(unsubscribe|manage preferences|email preferences|opt out|you are receiving this (email )?because)/i.test(
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

/** Calendar/meeting mail must be ingested and appear in Need your reply (never auto-skipped as promo). */
export function ingestForceRelevantCalendarOrMeeting(
  msg: InboundNoiseFields,
): { relevant: true; reason: string; confidence: number } | null {
  if (msg.direction && msg.direction !== 'INBOUND') return null;
  if (!looksLikeMeetingOrEventMail(msg)) return null;
  return {
    relevant: true,
    reason: 'Calendar or meeting event — tracked in Need your reply.',
    confidence: 1,
  };
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
  if (looksLikeMeetingOrEventMail(target)) return true;
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
    /(newsletter|digest|unsubscribe|promo code|promotion|campaign|webinar)/i.test(subject);
  const obviousBroadcastBody =
    /(unsubscribe|manage preferences|email preferences)/i.test(body);

  if (!isDirectToMailbox || !isSmallAudience) return false;
  if (automatedSender || obviousBroadcastSubject || obviousBroadcastBody) return false;
  return true;
}
