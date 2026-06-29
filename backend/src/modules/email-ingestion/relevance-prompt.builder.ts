import type { EmailMessage } from '../common/types';

/** Max plain-text chars for the message being classified. */
export const RELEVANCE_PROMPT_TARGET_BODY = 300;

/** Max plain-text chars for thread context messages (not the target). */
export const RELEVANCE_PROMPT_CONTEXT_BODY = 100;

export const RELEVANCE_MODEL_TEMPERATURE = 0.1;

/** Trust Gemini over promo heuristics when confidence is at or above this (optional model field). */
export const PROMO_CONFIDENCE_THRESHOLD = 0.72;

function sortThreadChronological(slice: EmailMessage[]): EmailMessage[] {
  return [...slice].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}

/**
 * System instruction — set once on the model. Gemini can implicitly cache this across calls.
 * Contains all static classification rules. Does NOT include per-mail dynamic content.
 */
export const RELEVANCE_SYSTEM_INSTRUCTION = `
You classify emails for a multi-tenant business follow-up portal (any company). For the message marked [TARGET], output one action.

## Actions (maps to portal tabs)
NEED_REPLY → Need reply tab. Someone expects a reply/decision from this mailbox.
CC → CC'd tab. Mailbox only on Cc (not in To). No reply expected.
BCC → BCC'd tab. Mailbox not in To or Cc (hidden copy). No reply expected.
CALENDAR → Calendar tab. Meeting invite, RSVP, calendar notification.
LOW → Low priority tab. FYI, receipts, thanks/noted closing a thread, no action needed.
SKIP → Skipped (not stored). Newsletters, promos, spam, platform noise.

## Rules (apply equally for every company — use only the mail content, not assumptions about the org)
- direction=OUTBOUND → NEED_REPLY.
- Mailbox only on Cc (not in To) → CC. Mailbox hidden (not in To/Cc) → BCC.
- Automated sender + unsubscribe footer + not addressed to mailbox → SKIP.
- Same-organization automated mail (HR, payroll, IT, helpdesk alerts; leave/expense approvals; system digests) with no question → LOW.
- Same-organization colleague FYI with no question or action ask → LOW. Colleague with explicit ask → NEED_REPLY.
- One-word client reply ("OK","Confirmed") in live thread → LOW.
- Client sends files/templates only (PFA, please find attached) with no question → LOW.
- Ticket/CRM/helpdesk auto-acknowledgements (request logged, case created, ticket opened) → LOW.
- Cold outreach without real name + company + specific ask → SKIP.
- Newsletter/digest/recruiter blast/summit promo/cold sales follow-up → SKIP.
- Meeting recap bots (Read.ai, Fathom, etc.) → SKIP or LOW.
- When uncertain → LOW (prefer calm inbox over false Need reply).

## Output
JSON only: {"action":"NEED_REPLY|CC|BCC|CALENDAR|LOW|SKIP","reason":"max 15 words"}
`;

/**
 * Per-call user prompt — only the dynamic parts (noise hint, mailbox, thread).
 * The static rules live in RELEVANCE_SYSTEM_INSTRUCTION (set as systemInstruction on the model).
 */
export function buildSharedIngestRelevancePrompt(
  target: EmailMessage,
  threadSlice: EmailMessage[],
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
): string {
  const noiseHint = hasNoiseGmailLabel ? 'yes' : 'no';
  const ordered = sortThreadChronological(threadSlice);

  const threadBlocks = ordered
    .map((msg) => {
      const isTarget = msg.providerMessageId === target.providerMessageId;
      const bodyLimit = isTarget ? RELEVANCE_PROMPT_TARGET_BODY : RELEVANCE_PROMPT_CONTEXT_BODY;
      const body = (msg.bodyText ?? '').slice(0, bodyLimit);
      const tag = isTarget ? '[TARGET]' : '[CTX]';

      return [
        `${tag} direction=${msg.direction} from=${msg.fromEmail}`,
        `to: ${(msg.toEmails ?? []).slice(0, 3).join(', ')}`,
        `subject: ${msg.subject ?? ''}`,
        body,
      ].join('\n');
    })
    .join('\n---\n');

  return `gmail_noise_hint_on_target: ${noiseHint}\ntracked_mailbox: ${employeeEmail}\n\n## Thread\n${threadBlocks}`;
}
