-- Separate product tracking window from Gmail polling and persist AI classification state.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS last_gmail_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ai_analysis_at TIMESTAMPTZ;

UPDATE employees
SET last_gmail_sync_at = COALESCE(last_gmail_sync_at, last_synced_at)
WHERE last_synced_at IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS classification_status TEXT NOT NULL DEFAULT 'classified',
  ADD COLUMN IF NOT EXISTS ai_confidence_score NUMERIC(4,3);

UPDATE conversations
SET ai_confidence_score = COALESCE(ai_confidence_score, confidence);

ALTER TABLE email_ingestion_skips
  ADD COLUMN IF NOT EXISTS classification_status TEXT NOT NULL DEFAULT 'skipped',
  ADD COLUMN IF NOT EXISTS skip_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS ai_confidence_score NUMERIC(4,3);

UPDATE email_ingestion_skips
SET skip_reason_code = CASE
    WHEN skip_reason_code IS NOT NULL THEN skip_reason_code
    WHEN COALESCE(skip_reason, '') ILIKE '%attachment%' THEN 'attachment_only'
    WHEN COALESCE(skip_reason, '') ILIKE '%empty%' THEN 'empty_body'
    WHEN COALESCE(skip_reason, '') ILIKE '%parse%' OR COALESCE(skip_reason, '') ILIKE '%failed%' THEN 'parsing_failed'
    WHEN COALESCE(skip_reason, '') ILIKE '%context%' OR COALESCE(skip_reason, '') ILIKE '%thread%' THEN 'missing_thread_context'
    WHEN COALESCE(skip_reason, '') ILIKE '%format%' OR COALESCE(skip_reason, '') ILIKE '%unsupported%' THEN 'unsupported_format'
    ELSE 'low_confidence'
  END
WHERE skip_kind <> 'before_tracking';

CREATE INDEX IF NOT EXISTS idx_email_ingestion_skips_employee_sent_at
  ON email_ingestion_skips (employee_id, sent_at DESC)
  WHERE sent_at IS NOT NULL AND skip_kind <> 'before_tracking';

CREATE INDEX IF NOT EXISTS idx_employees_tracking_sync_debug
  ON employees (company_id, tracking_start_at, last_gmail_sync_at, last_ai_analysis_at);
