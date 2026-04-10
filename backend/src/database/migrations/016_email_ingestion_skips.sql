-- Messages that were fetched but not stored (before tracking window or failed relevance).
-- Prevents re-downloading the same Gmail id every sync once we have decided to skip it.

CREATE TABLE IF NOT EXISTS email_ingestion_skips (
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_ingestion_skips_employee
  ON email_ingestion_skips (employee_id);

ALTER TABLE email_ingestion_skips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_email_ingestion_skips ON email_ingestion_skips;
CREATE POLICY service_role_all_email_ingestion_skips
  ON email_ingestion_skips FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
