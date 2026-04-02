/**
 * Build a mailto: link so the employee can reply to their manager by email.
 * Returns null if the manager’s email is missing.
 */
export function buildManagerReplyMailto(
  managerEmail: string | null | undefined,
  alertBody: string,
): string | null {
  const to = managerEmail?.trim();
  if (!to) return null;
  const subject = encodeURIComponent('Re: Your message (AI Auto Mail)');
  const quoted = alertBody.length > 1800 ? `${alertBody.slice(0, 1800)}…` : alertBody;
  const body = encodeURIComponent(
    `\n\n---\nYour manager wrote:\n${quoted}\n`,
  );
  return `mailto:${to}?subject=${subject}&body=${body}`;
}
