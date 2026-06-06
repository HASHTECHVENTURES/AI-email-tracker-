import type { EmailMessage } from '../common/types';

/** Max plain-text chars for the message being classified. */
export const RELEVANCE_PROMPT_TARGET_BODY = 800;

/** Max plain-text chars for thread context messages (not the target). */
export const RELEVANCE_PROMPT_CONTEXT_BODY = 300;

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
You classify emails for a business follow-up portal used by CEOs, managers, and employees. For the message marked [TARGET], output one action.

## Actions (maps to portal tabs)
NEED_REPLY → Need reply tab. Someone expects a reply/decision from this mailbox.
CC → CC'd tab. Mailbox only CC/BCC, not in To. No reply expected.
CALENDAR → Calendar tab. Meeting invite, RSVP, calendar notification.
LOW → Low priority tab. FYI, receipts <$300, thanks/noted closing a thread, no action needed.
SKIP → Skipped (not stored). Newsletters, promos, spam, platform noise.

## Rules
- direction=OUTBOUND → NEED_REPLY.
- Automated sender + unsubscribe footer + not addressed to mailbox → SKIP.
- One-word client reply ("OK","Confirmed") in live thread → LOW.
- Cold outreach without real name + company + specific ask → SKIP.
- When uncertain → NEED_REPLY.

## Output
JSON only: {"action":"NEED_REPLY|CC|CALENDAR|LOW|SKIP","reason":"max 15 words"}
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
