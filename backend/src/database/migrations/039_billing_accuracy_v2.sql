-- Billing v2: SQL aggregation (no 1000-row cap), body-size token estimates, optional calibration.

CREATE OR REPLACE FUNCTION estimate_relevance_billing_tokens(p_subject text, p_body text)
RETURNS TABLE(prompt_tokens int, output_tokens int)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    LEAST(
      3200,
      GREATEST(
        520,
        620
          + CEIL(LEAST(octet_length(COALESCE(p_body, '')), 300) / 4.0)::int
          + 25
          + CEIL(LEAST(octet_length(COALESCE(p_subject, '')), 200) / 4.0)::int
      )
    )::int AS prompt_tokens,
    28::int AS output_tokens;
$$;

CREATE OR REPLACE FUNCTION company_api_usage_totals(
  p_company_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE(
  api_calls BIGINT,
  prompt_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  api_cost_usd NUMERIC,
  live_calls BIGINT,
  estimate_calls BIGINT,
  live_cost_usd NUMERIC,
  estimate_cost_usd NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*)::bigint AS api_calls,
    COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt_tokens,
    COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
    COALESCE(SUM(u.total_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(u.estimated_cost_usd), 0)::numeric AS api_cost_usd,
    COUNT(*) FILTER (WHERE u.operation <> 'backfill_estimate')::bigint AS live_calls,
    COUNT(*) FILTER (WHERE u.operation = 'backfill_estimate')::bigint AS estimate_calls,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation <> 'backfill_estimate'), 0)::numeric AS live_cost_usd,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation = 'backfill_estimate'), 0)::numeric AS estimate_cost_usd
  FROM api_usage_events u
  WHERE u.company_id = p_company_id
    AND u.created_at >= p_from
    AND u.created_at < p_to;
$$;

INSERT INTO system_settings (key, value, updated_at)
VALUES ('billing_backfill_calibration', '1.0', NOW())
ON CONFLICT (key) DO NOTHING;

-- Re-estimate historical rows using prompt structure (300-char body cap + system overhead).
UPDATE api_usage_events u
SET
  prompt_tokens = est.prompt_tokens,
  output_tokens = est.output_tokens,
  total_tokens = est.prompt_tokens + est.output_tokens,
  estimated_cost_usd = ROUND(
    ((est.prompt_tokens::numeric / 1000000) * COALESCE(
      (SELECT NULLIF(value, '')::numeric FROM system_settings WHERE key = 'billing_gemini_input_usd_per_1m'),
      0.30
    ))
    + ((est.output_tokens::numeric / 1000000) * COALESCE(
      (SELECT NULLIF(value, '')::numeric FROM system_settings WHERE key = 'billing_gemini_output_usd_per_1m'),
      2.50
    )),
    6
  )
FROM email_messages em,
LATERAL estimate_relevance_billing_tokens(em.subject, em.body_text) est
WHERE u.operation = 'backfill_estimate'
  AND u.company_id = em.company_id
  AND u.employee_id IS NOT DISTINCT FROM em.employee_id
  AND u.created_at = em.ingested_at
  AND em.relevance_reason ~ '^\[(NEED_REPLY|CC|BCC|CALENDAR|LOW|SKIP)\]';
