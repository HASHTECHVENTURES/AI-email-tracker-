-- Fix storage metering: conversation text was counted once per message in thread (inflated ~5%).

CREATE OR REPLACE FUNCTION company_storage_bytes(p_company_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT SUM(octet_length(COALESCE(em.body_text, '')) + octet_length(COALESCE(em.subject, '')))
      FROM email_messages em
      WHERE em.company_id = p_company_id
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
  )::bigint;
$$;

-- Gemini 2.5 Flash official paid-tier rates (June 2026): $0.30 in / $2.50 out per 1M tokens
UPDATE system_settings SET value = '0.30', updated_at = NOW() WHERE key = 'billing_gemini_input_usd_per_1m';
UPDATE system_settings SET value = '2.50', updated_at = NOW() WHERE key = 'billing_gemini_output_usd_per_1m';
