/**
 * Migration 026 adds columns on employees, conversations, and email_ingestion_skips.
 * If production has not applied it yet, PostgREST returns errors referencing missing columns.
 */

export function isMigration026ColumnError(err: { message?: string } | null | undefined): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  if (!msg) return false;
  const looksLikeMissingColumn =
    msg.includes('could not find') ||
    msg.includes('does not exist') ||
    msg.includes('unknown column') ||
    msg.includes('schema cache');
  if (!looksLikeMissingColumn) return false;
  return (
    msg.includes('skip_reason_code') ||
    msg.includes('classification_status') ||
    msg.includes('ai_confidence_score') ||
    msg.includes('last_gmail_sync_at') ||
    msg.includes('last_ai_analysis_at')
  );
}

export function stripEmailIngestionSkips026Fields(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  delete out.skip_reason_code;
  delete out.classification_status;
  delete out.ai_confidence_score;
  return out;
}

export function stripEmployees026Fields(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  delete out.last_gmail_sync_at;
  delete out.last_ai_analysis_at;
  return out;
}

export function stripConversations026Fields(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  delete out.classification_status;
  delete out.ai_confidence_score;
  return out;
}
