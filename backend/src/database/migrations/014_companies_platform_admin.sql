-- Per-company kill switches (platform operator). When false, that tenant skips AI or Gmail ingestion.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS admin_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS admin_email_crawl_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN companies.admin_ai_enabled IS 'Platform: when false, skip AI enrichment and auto reports for this company.';
COMMENT ON COLUMN companies.admin_email_crawl_enabled IS 'Platform: when false, skip Gmail ingestion for this company.';
