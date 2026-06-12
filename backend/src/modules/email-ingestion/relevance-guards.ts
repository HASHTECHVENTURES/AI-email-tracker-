import type { EmailMessage } from '../common/types';
import { PROMO_CONFIDENCE_THRESHOLD } from './relevance-prompt.builder';

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

/** Same org domain as the tracked mailbox (e.g. colleague @opportune.in → niket@opportune.in). */
export function isInternalColleagueSender(
  employeeEmail: string,
  inboundFromEmail: string | null | undefined,
): boolean {
  const emp = (employeeEmail ?? '').trim().toLowerCase();
  const from = (inboundFromEmail ?? '').trim().toLowerCase();
  if (!emp.includes('@') || !from.includes('@')) return false;
  if (from === emp) return false;
  const empDomain = emp.split('@')[1];
  const fromDomain = from.split('@')[1];
  return Boolean(empDomain && fromDomain && empDomain === fromDomain);
}

function normalizeInboundAckBody(body: string): string {
  return body
    .replace(/[-–—]+\s*(?:forwarded|original)\s+message.*$/is, '')
    .replace(/^>.*$/gm, '')
    .replace(/on\s+.{5,80}\s+wrote:.*$/is, '')
    .trim();
}

function stripMobileReplySignature(text: string): string {
  return text
    .replace(/\bsent on move\b[\s\S]*$/i, '')
    .replace(/\bplease excuse brevity\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHORT_ACK_PATTERN =
  /^(?:approved!?|approval\s+granted|thanks?!?|thank\s+you!?|thx!?|ty!?|got\s+it!?|perfect!?|great!?|ok(?:ay)?!?|cool!?|noted!?|received!?|awesome!?|wonderful!?|sounds?\s+good!?|looks?\s+good!?|works?\s+for\s+(?:me|us)!?|will\s+do!?|on\s+it!?|done!?|sure!?|confirmed!?|no\s+(?:worries|problem)!?|all\s+(?:good|set|done)!?|we(?:'re| are)\s+(?:good|set|done)!?|much\s+appreciated!?|appreciate\s+it!?)[.!,]?\s*$/i;

/**
 * Calendar invites & meeting events from any sender (not only marketing@).
 * Covers Gmail "Invitation: … @ Mon May 18, 2026 5pm", Fireflies prep, ICS bodies, etc.
 *
 * Weak signals (meeting links, "when:/where:" fields) are NOT enough on their own —
 * a human-written email that just pastes a Meet/Zoom/Teams link should flow through
 * normal Gemini classification, not be auto-resolved as a calendar invite.
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

  const strongBodyHit =
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
    /organizer:\s*\S+@/i.test(b);

  if (subjectHit || strongBodyHit) return true;

  const hasMeetingLink =
    /https?:\/\/[^\s]*meet\.google\.com/i.test(b) ||
    /https?:\/\/[^\s]*zoom\.us\/(?:j|my)\//i.test(b) ||
    /https?:\/\/[^\s]*teams\.microsoft\.com/i.test(b);
  const hasStructuredFields =
    /\bwhen:\s*.{3,120}/i.test(b) ||
    /\bwhere:\s*.{3,120}/i.test(b);
  const hasInvitationPhrase =
    /\bhas invited you to\b/i.test(b) ||
    /\byou have been invited\b/i.test(b);

  const weakSignalCount =
    (hasMeetingLink ? 1 : 0) +
    (hasStructuredFields ? 1 : 0) +
    (hasInvitationPhrase ? 1 : 0);

  return weakSignalCount >= 2;
}

/**
 * Detects when the latest inbound message signals the conversation is closed/resolved
 * by the other party — e.g. "ticket closed", "issue resolved", "thanks, all good".
 * When true, the thread should auto-mark as DONE (no follow-up needed).
 */
export function looksLikeConversationClosure(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase().slice(0, 3_000);

  const closurePhrases =
    /\b(?:ticket|issue|case|request|bug|incident|query|complaint|task)\s+(?:is\s+)?(?:closed|resolved|completed|fixed|done|sorted|addressed)\b/i;

  const statusLine =
    /\bstatus\s*:\s*(?:closed|resolved|completed|fixed|done)\b/i;

  const conversationEnd =
    /\b(?:no\s+further\s+action|no\s+action\s+(?:needed|required)|no\s+reply\s+(?:needed|required)|nothing\s+else\s+needed|no\s+response\s+(?:needed|required))\b/i;

  const clientClosing =
    /\b(?:we(?:'re| are)\s+(?:all\s+set|good|done|sorted)|that(?:'s|s)\s+(?:all|it)|all\s+(?:good|set|done|sorted)|consider\s+(?:this|it)\s+(?:closed|resolved|done)|got\s+it|noted|received|perfect|works?\s+for\s+(?:me|us)|looks?\s+good|sounds?\s+good|great,?\s+thanks?|no\s+(?:worries|problem))\b/i;

  const thanksClosure =
    /\bthanks?,?\s+(?:that(?:'s|s)\s+all|we(?:'re| are)\s+good|no\s+need|all\s+good|all\s+set|nothing\s+else|no\s+further|so\s+much|a\s+lot|for\s+(?:the\s+)?(?:update|info|help|clarification|confirmation|quick|prompt))\b/i;

  const resolvedStandalone =
    /(?:^|\.\s*|\n\s*)(?:resolved|completed|closed|fixed|sorted|approved)\s*[.!]?\s*$/im;

  const approvalLead =
    /^(?:approved|approval\s+granted)[.!,]?\b/i.test(
      stripMobileReplySignature(normalizeInboundAckBody(body).split('\n')[0] ?? ''),
    );

  return (
    closurePhrases.test(sub) || closurePhrases.test(b) ||
    statusLine.test(sub) || statusLine.test(b) ||
    conversationEnd.test(b) ||
    clientClosing.test(b) ||
    thanksClosure.test(b) ||
    resolvedStandalone.test(b) ||
    approvalLead
  );
}

/**
 * Short acknowledgment messages (under ~60 chars of meaningful text) that signal
 * the client is done — especially after the employee already replied.
 * Use with timestamp context: only treat as closure when employee replied BEFORE this message.
 */
export function looksLikeShortAcknowledgment(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { body } = readInboundFields(msg);
  const normalized = normalizeInboundAckBody(body);
  const firstLine = stripMobileReplySignature(
    (normalized.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim(),
  );
  if (firstLine.length > 0 && firstLine.length <= 80 && SHORT_ACK_PATTERN.test(firstLine)) {
    return true;
  }

  const stripped = stripMobileReplySignature(normalized.replace(/\s+/g, ' ').trim());
  if (stripped.length > 120) return false;
  return SHORT_ACK_PATTERN.test(stripped);
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

export type IngestRelevanceAiVerdict = {
  relevant: boolean;
  reason: string | null;
  confidence: number | null;
};

/**
 * Post-Gemini overrides: confidence-gated promo skip, calendar force-in, direct-human safety.
 */
export function finalizeIngestRelevanceFromAi(
  target: EmailMessage,
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
  parsed: IngestRelevanceAiVerdict,
): IngestRelevanceAiVerdict {
  if (parsed.relevant) {
    const postAiNoise = ingestSkipReasonForInboundNoise(target, hasNoiseGmailLabel);
    if (postAiNoise && !looksLikeMeetingOrEventMail(target)) {
      const confidence = parsed.confidence ?? 0.5;
      if (confidence >= PROMO_CONFIDENCE_THRESHOLD) {
        return { relevant: true, reason: parsed.reason, confidence: parsed.confidence };
      }
      return { relevant: false, reason: postAiNoise, confidence: parsed.confidence };
    }
  }
  if (!parsed.relevant && looksLikeMeetingOrEventMail(target)) {
    return {
      relevant: true,
      reason: 'Calendar or meeting invite kept for Need your reply.',
      confidence: parsed.confidence,
    };
  }
  if (!parsed.relevant && looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel)) {
    return {
      relevant: true,
      reason:
        'Safety override: direct human mailbox message kept even though Inbox AI marked it not relevant.',
      confidence: parsed.confidence,
    };
  }
  return parsed;
}

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
