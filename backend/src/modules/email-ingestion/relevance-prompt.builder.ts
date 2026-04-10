import type { EmailMessage } from '../common/types';

/** Max plain-text chars per message in thread context sent to Gemini (up to 3 messages). */
export const RELEVANCE_PROMPT_PER_MESSAGE_BODY = 1_400;

function sortThreadChronological(slice: EmailMessage[]): EmailMessage[] {
  return [...slice].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
}

/**
 * Single shared inbox-relevance prompt for live ingestion and historical search.
 * Keeps Gemini behavior consistent so historical runs do not over-skip vs incremental sync.
 */
export function buildSharedIngestRelevancePrompt(
  target: EmailMessage,
  threadSlice: EmailMessage[],
  employeeEmail: string,
  hasNoiseGmailLabel: boolean,
): string {
  const ordered = sortThreadChronological(threadSlice);
  const threadBlocks = ordered.map((m, idx) => {
    const isTarget = m.providerMessageId === target.providerMessageId;
    const body = (m.bodyText ?? '').slice(0, RELEVANCE_PROMPT_PER_MESSAGE_BODY);
    return [
      `### Part ${idx + 1}/${ordered.length} — classification_target=${isTarget ? 'YES (decide on this message)' : 'no (context only)'}`,
      `gmail_message_id: ${m.providerMessageId}`,
      `direction: ${m.direction}`,
      `sent_at: ${m.sentAt.toISOString()}`,
      `from: ${m.fromEmail}`,
      `from_name: ${m.fromName ?? ''}`,
      `to: ${(m.toEmails ?? []).join(', ')}`,
      `cc: ${(m.ccEmails ?? []).join(', ')}`,
      `subject: ${m.subject ?? ''}`,
      '',
      'body_text:',
      body,
    ].join('\n');
  });

  return [
    '## Role',
    'You are the sole gatekeeper for a business email follow-up and SLA monitoring product.',
    'You receive up to three messages from the same Gmail thread (oldest first). Exactly one is marked classification_target=YES — that is the message being ingested now.',
    'Decide if that target message should enter the user’s tracked inbox (relevant=true) or be ignored (relevant=false).',
    'Use older parts only for conversation context (ongoing deal, open questions, prior commitments). Do not mark relevant=true only because an older part was important if the target message itself is pure noise.',
    'There is no code filter before you — your judgment is final for this step.',
    '',
    '## What “relevant” means',
    'True = a real person or organization expects this mailbox to notice, act, reply, decide, or stay informed about something work-related (or personally important to work), including:',
    '- Direct questions, requests, approvals, quotes, invoices, contracts, legal, HR, payroll, security, or compliance',
    '- Client, vendor, partner, investor, or government correspondence',
    '- Meeting invites or threads that include a real discussion (not only a blank machine-generated invite with no context)',
    '- Support tickets, escalations, incident reports, delivery or project updates that need a human response',
    '- Forwarded chains where the latest content still needs attention',
    '- Bounces, DMARC, or delivery failures ONLY if the user likely needs to fix DNS, recipients, or deliverability (actionable)',
    '- Cold outreach ONLY if it is clearly targeted (named ask, specific role/company) and plausibly worth a business reply; generic blast = false',
    '',
    '## What “not relevant” means',
    'False = no reasonable need for this mailbox to track or reply — typical bulk or machine-only noise:',
    '- Mass newsletters, digests, marketing, flash sales, “webinar recording”, unsubscribable promo',
    '- Purely automated receipts/invoices with no dispute or action (unless amounts/terms need review — then true)',
    '- Password resets, 2FA codes, login alerts, routine “your report is ready” with no decision',
    '- GitHub/Jira/Slack/CI bot spam with no human question in the snippet',
    '- Empty or template-only out-of-office with no thread context',
    '- Obvious phishing or pure spam (if unsure, prefer true so a human can delete)',
    '',
    '## Signals (hints only)',
    `gmail_noise_hint_on_target=${hasNoiseGmailLabel ? 'yes' : 'no'} (Promotions/Forums/Updates — weak signal; do not reject on this alone).`,
    '- From-address may be noreply, mailer-daemon, or postmaster — read the body; bounce notices can be relevant.',
    '',
    '## Tie-breakers',
    '- If the target message could require human judgment, reply, or follow-up within ~2 weeks → relevant=true.',
    '- If the target is only informational broadcast with no plausible action → relevant=false.',
    '- When uncertain about the target, prefer relevant=true so important mail is not silently dropped.',
    '',
    '## Output',
    'Return ONLY valid JSON (no markdown fences). Keys:',
    '{"relevant":true|false,"reason":"one concise sentence citing the decisive factor (about the target message)"}',
    '',
    `tracked_mailbox (employee): ${employeeEmail}`,
    '',
    '## Thread (chronological)',
    ...threadBlocks,
  ].join('\n');
}
