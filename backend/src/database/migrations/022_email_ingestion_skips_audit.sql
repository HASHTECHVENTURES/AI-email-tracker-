-- Richer audit trail for skipped ingestion (AI irrelevant, before tracking window, etc.)

ALTER TABLE email_ingestion_skips
  ADD COLUMN IF NOT EXISTS skip_kind TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS skip_reason TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS from_email TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_email_ingestion_skips_employee_skipped
  ON email_ingestion_skips (employee_id, skipped_at DESC);
