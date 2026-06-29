-- One-time estimate for Gemini classify calls before api_usage_events metering existed.
-- Rows use operation = 'backfill_estimate' (clearly labeled in admin billing UI).

INSERT INTO system_settings (key, value, updated_at)
VALUES ('billing_backfill_v1_completed', 'false', NOW())
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  input_rate NUMERIC;
  output_rate NUMERIC;
  prompt_est INT := 800;
  output_est INT := 45;
  cost_est NUMERIC;
BEGIN
  IF EXISTS (
    SELECT 1 FROM system_settings
    WHERE key = 'billing_backfill_v1_completed' AND value = 'true'
  ) THEN
    RETURN;
  END IF;

  SELECT COALESCE(NULLIF(value, '')::numeric, 0.30)
  INTO input_rate
  FROM system_settings WHERE key = 'billing_gemini_input_usd_per_1m';

  SELECT COALESCE(NULLIF(value, '')::numeric, 2.50)
  INTO output_rate
  FROM system_settings WHERE key = 'billing_gemini_output_usd_per_1m';

  cost_est := ROUND(
    ((prompt_est::numeric / 1000000) * input_rate) + ((output_est::numeric / 1000000) * output_rate),
    6
  );

  INSERT INTO api_usage_events (
    company_id,
    employee_id,
    operation,
    model,
    prompt_tokens,
    output_tokens,
    total_tokens,
    estimated_cost_usd,
    created_at
  )
  SELECT
    em.company_id,
    em.employee_id,
    'backfill_estimate',
    'gemini-2.5-flash',
    prompt_est,
    output_est,
    prompt_est + output_est,
    cost_est,
    em.ingested_at
  FROM email_messages em
  WHERE em.relevance_reason ~ '^\[(NEED_REPLY|CC|BCC|CALENDAR|LOW|SKIP)\]'
    AND NOT EXISTS (
      SELECT 1 FROM api_usage_events u
      WHERE u.company_id = em.company_id
        AND u.employee_id IS NOT DISTINCT FROM em.employee_id
        AND u.operation = 'backfill_estimate'
        AND u.created_at = em.ingested_at
    );

  UPDATE system_settings
  SET value = 'true', updated_at = NOW()
  WHERE key = 'billing_backfill_v1_completed';

  IF NOT FOUND THEN
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('billing_backfill_v1_completed', 'true', NOW());
  END IF;
END $$;
