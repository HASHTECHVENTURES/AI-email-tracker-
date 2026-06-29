import type { EmailMessage } from '../common/types';
import { PROMO_CONFIDENCE_THRESHOLD } from './relevance-prompt.builder';

/** Options for layered ingest noise (no domain hardcoding). */
export type IngestNoiseOptions = {
  excludePatterns?: string[];
  threadSlice?: EmailMessage[];
};

/** Merge company + mailbox blocklists (deduped). */
export function mergeExcludePatterns(
  companyPatterns: string[] | undefined | null,
  mailboxPatterns: string[] | undefined | null,
): string[] {
  return [
    ...new Set(
      [...(companyPatterns ?? []), ...(mailboxPatterns ?? [])]
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
}

/** Minimal fields for noise heuristics (ingest + conversation recompute). */
export type InboundNoiseFields = {
  direction?: string;
  from_email?: string;
  fromEmail?: string;
  subject?: string | null;
  body_text?: string | null;
  bodyText?: string | null;
  mailListUnsubscribe?: boolean;
  mailPrecedenceBulk?: boolean;
  providerMessageId?: string;
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

/** Same org domain as the tracked mailbox — works for any tenant (colleague @company.com → employee@company.com). */
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

/**
 * Generic HR / payroll / workflow auto-notices (any company, any HRIS or helpdesk product).
 * Company-specific subject lines can also be added via Settings → email exclude patterns.
 */
export function looksLikeGenericHrOrWorkflowAutomatedSubject(subject: string): boolean {
  const sub = subject.toLowerCase();
  return (
    /\battendance\s+(?:alert|notification|reminder|regulari[sz])/i.test(sub) ||
    /\b(?:timesheet|time\s*sheet)\s+(?:alert|reminder|due|submitted)/i.test(sub) ||
    /\b(?:leave|time\s*off|pto|wfh|work\s*from\s*home|half\s*day|casual\s*leave|sick\s*leave).{0,100}\b(?:approved|rejected)\s+by\b/i.test(
      sub,
    ) ||
    /\b(?:request|application)\s+by\b.{0,100}\bapproved\s+by\b/i.test(sub) ||
    /\b(?:expense|reimbursement|claim).{0,80}\b(?:approved|processed|submitted)\b/i.test(sub) ||
    /\b(?:activity|task)\s+list\b/i.test(sub) ||
    /\b(?:workflow|process)\s+(?:activity|notification|reminder)\b/i.test(sub) ||
    /\b(?:overdue|delayed|pending).{0,40}(?:task|ticket|tracker|item|activit)/i.test(sub) ||
    /\bdaily\s+alert\b/i.test(sub) ||
    /\bhappy\s+birthday\b/i.test(sub) ||
    /\b(?:payroll|payslip|salary)\s+(?:processed|generated|alert|notification)/i.test(sub)
  );
}

/** Local-part patterns for org-wide automated mailboxes (support@, hr@, noreply@, etc.). */
const AUTOMATED_MAILBOX_LOCAL_RE =
  /^(?:support|helpdesk|it-?support|hr|payroll|noreply|no-reply|donotreply|do-not-reply|notifications?|alerts?|notify|system|automated|mailer-daemon)$/i;

/**
 * Same-domain mail that is FYI, auto-generated, or already closed — not a real to-do.
 * Applies per tracked mailbox domain; no tenant-specific company names or products.
 */
export function looksLikeInternalFyiOrAutomated(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const chunk = extractLatestInboundComposeBody(body).slice(0, 900).toLowerCase();
  const combined = `${sub} ${chunk}`;

  if (looksLikeShortAcknowledgment(msg) || looksLikeConversationClosure(msg)) {
    return true;
  }

  if (looksLikeGenericHrOrWorkflowAutomatedSubject(subject)) {
    return true;
  }

  const fromLocal = (from.split('@')[0] ?? '').toLowerCase();
  if (
    AUTOMATED_MAILBOX_LOCAL_RE.test(fromLocal) &&
    /\b(?:alert|notification|reminder|digest|activity\s+list|attendance|birthday|approved|processed|ticket\s+update|case\s+update)\b/i.test(
      combined,
    ) &&
    !looksLikeInboundReplyQuestion(msg)
  ) {
    return true;
  }

  if (
    /\b(?:fyi|for your information|for ur information)\b/i.test(chunk) &&
    !looksLikeInboundReplyQuestion(msg)
  ) {
    return true;
  }

  if (
    /\b(?:do not reply|this is an automated|automated message|auto-generated)\b/i.test(chunk) &&
    !looksLikeInboundReplyQuestion(msg)
  ) {
    return true;
  }

  return false;
}

/** Same-domain mail that clearly expects a human reply (question, urgent ask, leave query, etc.). */
export function looksLikeInternalActionRequired(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  if (looksLikeInternalFyiOrAutomated(msg)) return false;

  if (looksLikeInboundReplyQuestion(msg)) return true;

  const { subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const chunk = extractLatestInboundComposeBody(body).slice(0, 900).toLowerCase();
  const combined = `${sub}\n${chunk}`;

  return /\b(?:urgent|asap|action required|approval required|please help|need help|leave query|leave balance|pending your|awaiting your|kindly help|please assist|look into|do the needful|resolve this|fix this)\b/i.test(
    combined,
  );
}

function normalizeInboundAckBody(body: string): string {
  return body
    .replace(/[-–—]+\s*(?:forwarded|original)\s+message.*$/is, '')
    .replace(/^>.*$/gm, '')
    .replace(/on\s+.{5,80}\s+wrote:.*$/is, '')
    .trim();
}

/** Top compose block only — strips Gmail/Outlook quoted thread below "On … wrote:". */
function extractLatestInboundComposeBody(body: string): string {
  let text = (body ?? '').replace(/\r\n/g, '\n');
  const wroteIdx = text.search(/\n\s*on\s+.{10,140}\s+wrote\s*:/i);
  if (wroteIdx > 0) text = text.slice(0, wroteIdx);
  return stripMobileReplySignature(
    normalizeInboundAckBody(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
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

  if (/\bmicrosoft teams meeting\b/i.test(b) && /teams\.microsoft\.com/i.test(b)) {
    return true;
  }

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
    /\b(?:we(?:'re| are)\s+(?:all\s+set|good|done|sorted)|that(?:'s|s)\s+(?:all|it)|all\s+(?:good|set|done|sorted)|consider\s+(?:this|it)\s+(?:closed|resolved|done)|got\s+it|noted|received|perfect|works?\s+for\s+(?:me|us)|looks?\s+good|sounds?\s+good|great,?\s+thanks?|no\s+(?:worries|problem)|working\s+as\s+expected|thank\s+you\s+for\s+(?:the\s+)?quick\s+resolution)\b/i;

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
/**
 * True when the inbound text clearly asks for a reply, review, or confirmation.
 * Used to avoid auto-resolving deliverable FYI mail that also contains a question.
 */
export function looksLikeInboundReplyQuestion(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { subject, body } = readInboundFields(msg);
  const chunk = extractLatestInboundComposeBody(body).slice(0, 900);
  const combined = `${subject}\n${chunk}`;
  if (combined.includes('?')) return true;

  return /\b(?:please|kindly)\s+(?:confirm|review|check|advise|revert|update\s+us|let\s+me\s+know)\b|\b(?:could|can|would)\s+you\b|\blet\s+me\s+know\b|\bawaiting\s+(?:your|the)\b|\bneed\s+(?:your|the)\b|\bplease\s+(?:reply|respond)\b|\bwhen\s+(?:can|will|do)\s+you\b|\bkindly\s+share\b/i.test(
    combined,
  );
}

/**
 * Client sends requested files/templates (PFA, attachments) without asking for a reply.
 * e.g. "PFA Employee Salary Master template" after kickoff discussion.
 */
export function looksLikeClientDeliverableFyi(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  if (looksLikeInboundReplyQuestion(msg)) return false;

  const { subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const firstChunk = extractLatestInboundComposeBody(body).slice(0, 600);
  const combined = `${sub} ${firstChunk}`.toLowerCase();

  if (
    /\b(?:sponsorship|sponsor details|summit|conference|expo|symposium|peopletech|ibc \()\b/i.test(
      combined,
    )
  ) {
    return false;
  }

  const attachmentShare =
    /\b(?:p\.?\s*f\.?\s*a\.?|please\s+find\s+attached|please\s+find\s+the\s+attached|find\s+attached|attached\s+(?:is|are|herewith|please\s+find)|enclosed\s+(?:is|are|please\s+find)|herewith\s+(?:the|is|are)?\s*|attached\s+(?:file|files|template|document|sheet|excel|pdf|format|master))\b/i.test(
      combined,
    ) ||
    /\bsharing\s+(?:the\s+)?(?:\w+\s+){0,5}(?:template|file|document|sheet|format|master|data)\b/i.test(
      combined,
    ) ||
    /\b(?:as\s+(?:discussed|requested|agreed))[\s\S]{0,100}\b(?:attach|template|file|document|pfa)\b/i.test(
      combined,
    );

  const subjectPfa =
    /\bp\.?\s*f\.?\s*a\.?\b/i.test(sub) ||
    (/\battached\b/i.test(sub) && /\b(?:template|file|document|master|sheet)\b/i.test(sub));

  return attachmentShare || (subjectPfa && firstChunk.length < 450);
}

/**
 * Client promises to send/share a file by a date — informational after employee already replied.
 * e.g. "will share salary template by tomorrow evening".
 */
export function looksLikeClientSharePromiseFyi(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  if (looksLikeInboundReplyQuestion(msg)) return false;

  const { body } = readInboundFields(msg);
  const firstLine = extractLatestInboundComposeBody(body).slice(0, 320);

  return (
    /\b(?:will|shall)\s+(?:share|send)\s+(?:the\s+)?[\w\s]{0,40}(?:template|file|document|sheet|format|data|details?|master)\s+(?:by|on|before|today|tomorrow|eod|end\s+of\s+(?:the\s+)?day)/i.test(
      firstLine,
    ) ||
    /\b(?:sharing|sending)\s+(?:the\s+)?[\w\s]{0,30}(?:template|file|document|master)\s+(?:by|on|before|today|tomorrow)/i.test(
      firstLine,
    )
  );
}

/**
 * Helpdesk / CRM / platform auto-notifications — not a human expecting a reply.
 * e.g. ticket logged ack, vtiger "opportunity assigned".
 */
export function looksLikeAutomatedSystemNotification(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const head = extractLatestInboundComposeBody(body).slice(0, 900).toLowerCase();
  const combined = `${sub} ${head}`;

  if (
    /(?:hrservicedesk|helpdesk|servicedesk|support-desk|ticketingsystem|zendesk|freshdesk|jira-mail|atlassian|service-now|servicenow|netmagic|mailalerts@)\b/i.test(
      from,
    )
  ) {
    return true;
  }

  if (
    /^case:\s*cs\d+\s+has been created\b/i.test(sub) ||
    /\bauto-?ticket\b/i.test(sub) ||
    /\bservice alert\b/i.test(sub)
  ) {
    return true;
  }

  if (
    /\b(?:resignation|approval)\s+(?:is\s+)?(?:still\s+)?pending\b/i.test(combined) &&
    /\b(?:reminder|escalation|final reminder)\b/i.test(combined)
  ) {
    return true;
  }

  if (
    /(?:vtiger|salesforce|hubspot|zoho\s*crm|pipedrive|freshsales|monday\.com)\b/i.test(from) ||
    /(?:vtiger|salesforce|hubspot)\b/i.test(combined)
  ) {
    return true;
  }

  const ticketAck =
    /\b(?:request|ticket|case)\s+(?:has been\s+)?(?:logged|created|registered|submitted|opened)\b/i.test(
      combined,
    ) ||
    /\b(?:acknowledgement|acknowledgment)\s+mail\b/i.test(combined) ||
    /\byour request has been created\b/i.test(combined) ||
    /request id\s*#*#*\d+/i.test(combined) ||
    /^your request has been logged\b/i.test(sub);

  const crmAssign =
    /\b(?:new\s+)?opportunity\s+has been assigned\b/i.test(combined) ||
    /\blead\s+has been assigned\b/i.test(combined) ||
    /\bassigned to you on\s+(?:vtiger|salesforce|zoho|hubspot)/i.test(combined) ||
    /^new opportunity has been assigned\b/i.test(sub);

  const systemFooter =
    /\b(?:do not reply to this (?:email|message)|this is an automated (?:message|notification|email))\b/i.test(
      head,
    );

  return ticketAck || crmAssign || systemFooter;
}

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

/** Post-meeting AI recap / report digests — not a live calendar invite. */
export function looksLikeMeetingRecapOrReportMail(msg: InboundNoiseFields): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase().slice(0, 2_000);

  if (/@(?:e\.read\.ai|fathom\.video|fireflies\.ai)\b/i.test(from)) {
    return /\b(?:meeting report|recap|read meeting)\b/i.test(sub) || /\bmeeting report\b/i.test(b);
  }

  return (
    /\b(?:meeting report|recap of your meeting|read meeting report)\b/i.test(sub) ||
    /\bmonthly performance report\b/i.test(sub)
  );
}

/**
 * Company or mailbox blocklist — substring match on from, subject, or body preview.
 * Patterns are user-managed in Settings (no code deploy for new spammers).
 */
export function matchesExcludePatterns(
  msg: InboundNoiseFields,
  patterns: string[] | undefined | null,
): boolean {
  if (!patterns?.length) return false;
  const { from, subject, body } = readInboundFields(msg);
  const haystack = `${from} ${subject.toLowerCase()} ${body.slice(0, 500).toLowerCase()}`;
  return patterns.some((raw) => {
    const pat = raw.trim().toLowerCase();
    return pat.length > 0 && haystack.includes(pat);
  });
}

/** RFC 2369 List-Unsubscribe or Precedence: bulk/list — strong newsletter signal. */
export function hasBulkMailHeaders(msg: InboundNoiseFields): boolean {
  if (msg.mailListUnsubscribe === true || msg.mailPrecedenceBulk === true) return true;
  return false;
}

/** True when the employee already replied earlier in this thread (existing relationship). */
export function threadHasPriorEmployeeReply(
  threadSlice: EmailMessage[] | undefined,
  targetMessageId: string | undefined,
): boolean {
  if (!threadSlice?.length || !targetMessageId) return false;
  const ordered = [...threadSlice].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const targetIdx = ordered.findIndex((m) => m.providerMessageId === targetMessageId);
  const before = targetIdx >= 0 ? ordered.slice(0, targetIdx) : ordered.slice(0, -1);
  return before.some((m) => m.direction === 'OUTBOUND');
}

/**
 * Generic cold outreach / recruiter spam / event promo — no domain allowlists.
 * Skipped only on new threads (no prior employee reply in context).
 */
export function looksLikeGenericColdOutreach(
  msg: InboundNoiseFields,
  priorEmployeeReply: boolean,
): boolean {
  if (priorEmployeeReply) return false;
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const { subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const chunk = extractLatestInboundComposeBody(body).slice(0, 1_200);

  if (/\bhotlist\b/i.test(sub)) return true;
  if (/(?:\||\/)\s*(?:developer|engineer|lead|manager|architect|devops|sap|\.net)/i.test(sub)) {
    return true;
  }

  if (
    /\b(?:summit|unconference|webinar|blockbuster show|early bird|talent acquisition leader)\b/i.test(
      sub,
    )
  ) {
    return true;
  }

  const coldPhrases =
    /\b(?:since i have not heard back|i will close your file|building on my previous note|slipped through the cracks|reaching out to introduce|quick intro|quick question|i(?:'d)? love to (?:connect|chat)|can we schedule (?:a )?(?:call|meeting)|wanted to (?:reach out|introduce))\b/i;
  if (coldPhrases.test(chunk)) return true;

  return false;
}

/**
 * Gmail Promotions / Social / Forums — hard skip for new inbound threads only.
 * Keeps misfiled client mail when the employee already replied in-thread.
 */
export function shouldHardSkipGmailCategoryNoise(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel: boolean,
  priorEmployeeReply: boolean,
): boolean {
  if (!hasNoiseGmailLabel) return false;
  if (priorEmployeeReply) return false;
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  return true;
}

/**
 * Layered high-confidence noise: blocklist → bulk headers → Gmail category → cold outreach templates.
 * All rule-based — zero API credits.
 */
export function looksLikeHighConfidenceIngestNoise(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel: boolean,
  options?: IngestNoiseOptions,
): boolean {
  const patterns = options?.excludePatterns ?? [];
  if (matchesExcludePatterns(msg, patterns)) return true;
  if (hasBulkMailHeaders(msg)) return true;

  const targetId = msg.providerMessageId;
  const priorReply = threadHasPriorEmployeeReply(options?.threadSlice, targetId);

  if (shouldHardSkipGmailCategoryNoise(msg, hasNoiseGmailLabel, priorReply)) return true;
  if (looksLikeGenericColdOutreach(msg, priorReply)) return true;

  return false;
}

/** Marketing / promo / newsletter-style mail (Gmail Promotions label is a strong signal). */
export function looksLikePromotionalMail(
  msg: InboundNoiseFields,
  hasNoiseGmailLabel = false,
  options?: IngestNoiseOptions,
): boolean {
  if (looksLikeMeetingRecapOrReportMail(msg)) return true;

  if (looksLikeMeetingOrEventMail(msg)) return false;

  if (looksLikeHighConfidenceIngestNoise(msg, hasNoiseGmailLabel, options)) return true;

  const { from, subject, body } = readInboundFields(msg);
  const sub = subject.toLowerCase();
  const b = body.toLowerCase();

  if (hasNoiseGmailLabel) return true;

  if (/businessprofile-noreply@google\.com/i.test(from)) return true;
  if (
    /@(?:e\.read\.ai|fathom\.video|email\.openai\.com|e\.shrm\.org|ippgroup\.in|easemytrip\.com|cloudsupport-help\.freshdesk\.com)\b/i.test(
      from,
    )
  ) {
    return true;
  }

  if (
    /\b(?:sponsorship opportunit|summit & award|invites you to|performance report for|newsletter|webinar invite)\b/i.test(
      sub,
    )
  ) {
    return true;
  }

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
    /(newsletter|digest|unsubscribe|promo code|promotion|campaign|webinar|view in browser|flash sale|limited time offer|\d+%\s*off|save\s+(?:up\s+to\s+)?\d+%|coupon|free shipping|shop now|exclusive deal|change of view)/i.test(
      sub,
    )
  ) {
    return true;
  }

  if (/save\s+up\s+to\s+\d+%/i.test(b)) {
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
  options?: IngestNoiseOptions,
): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;
  return looksLikePromotionalMail(msg, hasNoiseGmailLabel, options);
}

/** Calendar/meeting mail must be ingested and appear in Need your reply (never auto-skipped as promo). */
export function ingestForceRelevantCalendarOrMeeting(
  msg: InboundNoiseFields,
): { relevant: true; reason: string; confidence: number } | null {
  if (msg.direction && msg.direction !== 'INBOUND') return null;
  if (looksLikeMeetingRecapOrReportMail(msg)) return null;
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
  options?: IngestNoiseOptions,
): string | null {
  if (matchesExcludePatterns(msg, options?.excludePatterns)) {
    return 'Sender matches blocklist pattern — not a customer reply thread.';
  }
  if (hasBulkMailHeaders(msg)) {
    return 'Newsletter or bulk mailing-list message — not a customer reply thread.';
  }
  const targetId = msg.providerMessageId;
  const priorReply = threadHasPriorEmployeeReply(options?.threadSlice, targetId);
  if (shouldHardSkipGmailCategoryNoise(msg, hasNoiseGmailLabel, priorReply)) {
    return 'Gmail Promotions/Social tab — not a customer reply thread.';
  }
  if (looksLikeGenericColdOutreach(msg, priorReply)) {
    return 'Cold outreach or event promo — not a customer reply thread.';
  }
  if (!looksLikeInboundNoReplyNoise(msg, hasNoiseGmailLabel, options)) return null;
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
  options?: IngestNoiseOptions,
): IngestRelevanceAiVerdict {
  if (parsed.relevant) {
    const postAiNoise = ingestSkipReasonForInboundNoise(target, hasNoiseGmailLabel, options);
    if (postAiNoise && !looksLikeMeetingOrEventMail(target)) {
      if (looksLikeHighConfidenceIngestNoise(target, hasNoiseGmailLabel, options)) {
        return { relevant: false, reason: postAiNoise, confidence: parsed.confidence };
      }
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
  if (!parsed.relevant && looksLikeDirectHumanMail(target, employeeEmail, hasNoiseGmailLabel, options)) {
    return {
      relevant: true,
      reason:
        'Safety override: direct human mailbox message kept even though Inbox AI marked it not relevant.',
      confidence: parsed.confidence,
    };
  }
  if (parsed.relevant && looksLikeInternalFyiOrAutomated(target)) {
    return {
      relevant: true,
      reason: 'Automated workplace notification — no reply needed.',
      confidence: parsed.confidence,
    };
  }
  if (
    parsed.relevant &&
    isInternalColleagueSender(employeeEmail, target.fromEmail) &&
    !looksLikeInternalActionRequired(target)
  ) {
    return {
      relevant: true,
      reason: 'Internal colleague message — informational only.',
      confidence: parsed.confidence,
    };
  }
  return parsed;
}

export function looksLikeDirectHumanMail(
  target: EmailMessage,
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
  options?: IngestNoiseOptions,
): boolean {
  if (target.direction !== 'INBOUND') return false;
  if (looksLikeMeetingOrEventMail(target)) return true;
  if (hasNoiseGmailLabel) return false;
  if (looksLikeHighConfidenceIngestNoise(target, hasNoiseGmailLabel, options)) return false;
  if (looksLikeInboundNoReplyNoise(target, hasNoiseGmailLabel, options)) return false;

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
  if (looksLikeAutomatedSystemNotification(target)) return false;
  if (looksLikeInboundNoReplyNoise(target, hasNoiseGmailLabel, options)) return false;
  if (isInternalColleagueSender(employeeEmail, target.fromEmail)) {
    if (looksLikeInternalFyiOrAutomated(target)) return false;
    if (!looksLikeInternalActionRequired(target)) return false;
  }
  return true;
}

/**
 * Latest inbound opens with "Dear {Name}" directed at someone other than the tracked mailbox
 * (e.g. "Dear Mohit, please check" on Anurag's thread after Anurag already replied).
 */
export function looksLikeInboundDirectedAtSomeoneElse(
  msg: InboundNoiseFields,
  employeeEmail: string,
): boolean {
  if (msg.direction && msg.direction !== 'INBOUND') return false;

  const head = extractLatestInboundComposeBody(readInboundFields(msg).body).slice(0, 400);
  const dearMatch = head.match(/^dear\s+([a-z][\w.]*)/i);
  if (!dearMatch) return false;

  const named = dearMatch[1].toLowerCase();
  const empLocal = employeeEmail.trim().toLowerCase().split('@')[0] ?? '';
  const empFirst = empLocal.split(/[._-]/)[0] ?? '';
  if (!empFirst || named === empFirst || named.startsWith(empFirst)) return false;

  return /\b(?:please|kindly|pls)\s+check\b/i.test(head);
}

export type RuleBasedIngestAction = {
  relevant: boolean;
  reason: string;
  confidence: number;
  aiAction: 'NEED_REPLY' | 'CC' | 'BCC' | 'CALENDAR' | 'LOW' | 'SKIP';
};

type IngestDecisionFields = {
  relevant: boolean;
  reason: string | null;
  confidence: number | null;
  aiAction?: string;
};

/** Post-classification guard — keeps aiAction aligned with rule heuristics (self-healing at ingest). */
export function coerceIngestClassificationDecision(
  target: EmailMessage,
  employeeEmail: string,
  decision: IngestDecisionFields,
): IngestDecisionFields {
  if (!decision.relevant) return decision;

  if (looksLikeInternalFyiOrAutomated(target)) {
    return {
      ...decision,
      aiAction: 'LOW',
      reason: 'Automated workplace notification — no reply needed.',
    };
  }

  if (
    isInternalColleagueSender(employeeEmail, target.fromEmail) &&
    !looksLikeInternalActionRequired(target)
  ) {
    return {
      ...decision,
      aiAction: 'LOW',
      reason: 'Internal colleague message — informational only.',
    };
  }

  if (
    decision.aiAction === 'NEED_REPLY' &&
    looksLikeAutomatedSystemNotification(target)
  ) {
    return {
      ...decision,
      aiAction: 'LOW',
      reason: 'Automated ticket/CRM notification — no reply needed.',
    };
  }

  return decision;
}

/**
 * Free rule-based classification — no Gemini. Returns null when AI is still needed.
 */
export function ruleBasedIngestClassification(
  target: EmailMessage,
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
  options?: IngestNoiseOptions,
): RuleBasedIngestAction | null {
  if (target.direction === 'OUTBOUND') {
    return {
      relevant: true,
      reason: 'Outbound — your sent message (reply detection / SLA)',
      confidence: 1,
      aiAction: 'NEED_REPLY',
    };
  }

  const calendarIngest = ingestForceRelevantCalendarOrMeeting(target);
  if (calendarIngest) {
    return { ...calendarIngest, aiAction: 'CALENDAR' };
  }

  const noiseSkip = ingestSkipReasonForInboundNoise(target, hasNoiseGmailLabel, options);
  if (noiseSkip) {
    return { relevant: false, reason: noiseSkip, confidence: 1, aiAction: 'SKIP' };
  }

  if (looksLikeClientDeliverableFyi(target)) {
    return {
      relevant: true,
      reason: 'Client attachment or template share — informational only.',
      confidence: 1,
      aiAction: 'LOW',
    };
  }

  if (looksLikeAutomatedSystemNotification(target)) {
    return {
      relevant: true,
      reason: 'Automated ticket/CRM notification — no reply needed.',
      confidence: 1,
      aiAction: 'LOW',
    };
  }

  if (looksLikeConversationClosure(target)) {
    return {
      relevant: true,
      reason: 'Client indicated the conversation is closed — no reply needed.',
      confidence: 1,
      aiAction: 'LOW',
    };
  }

  if (isInternalColleagueSender(employeeEmail, target.fromEmail)) {
    if (looksLikeInternalFyiOrAutomated(target)) {
      return {
        relevant: true,
        reason: 'Automated workplace notification — no reply needed.',
        confidence: 1,
        aiAction: 'LOW',
      };
    }
    if (looksLikeInternalActionRequired(target)) {
      return {
        relevant: true,
        reason: 'Internal colleague message — reply may be needed.',
        confidence: 1,
        aiAction: 'NEED_REPLY',
      };
    }
    return {
      relevant: true,
      reason: 'Internal colleague message — informational only.',
      confidence: 1,
      aiAction: 'LOW',
    };
  }

  if (target.direction === 'INBOUND') {
    const m = employeeEmail.trim().toLowerCase();
    const inTo = (target.toEmails ?? []).some((e) => e.trim().toLowerCase() === m);
    if (!inTo) {
      const inCc = (target.ccEmails ?? []).some((e) => e.trim().toLowerCase() === m);
      if (inCc) {
        return {
          relevant: true,
          reason: 'Mailbox only in CC — no reply expected.',
          confidence: 1,
          aiAction: 'CC',
        };
      }
      return {
        relevant: true,
        reason: 'Mailbox BCC — informational only.',
        confidence: 1,
        aiAction: 'BCC',
      };
    }
  }

  return null;
}
