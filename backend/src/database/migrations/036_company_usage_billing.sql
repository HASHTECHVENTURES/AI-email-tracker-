-- Per-tenant API usage ledger and billing configuration.

CREATE TABLE IF NOT EXISTS api_usage_events (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees (id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_usage_events_company_created
  ON api_usage_events (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_usage_events_created
  ON api_usage_events (created_at DESC);

COMMENT ON TABLE api_usage_events IS
  'Gemini (and future) API call ledger — one row per generateContent with token counts and estimated USD cost.';

CREATE OR REPLACE FUNCTION company_storage_bytes(p_company_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    SUM(
      octet_length(COALESCE(em.body_text, ''))
      + octet_length(COALESCE(em.subject, ''))
    ),
    0
  )::bigint
  + COALESCE(
    (
      SELECT SUM(octet_length(COALESCE(c.summary, '')) + octet_length(COALESCE(c.reason, '')))
      FROM conversations c
      WHERE c.company_id = p_company_id
    ),
    0
  )::bigint
  FROM email_messages em
  WHERE em.company_id = p_company_id;
$$;

INSERT INTO system_settings (key, value, updated_at)
VALUES
  ('billing_gemini_input_usd_per_1m', '0.30', NOW()),
  ('billing_gemini_output_usd_per_1m', '2.50', NOW()),
  ('billing_storage_usd_per_gb_month', '0.125', NOW()),
  ('billing_usd_to_inr', '83', NOW()),
  ('billing_platform_fee_inr_month', '0', NOW())
ON CONFLICT (key) DO NOTHING;
