-- Daily and monthly billing breakdowns (calendar months, IST day boundaries).

CREATE OR REPLACE FUNCTION api_usage_daily_totals(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_company_id UUID DEFAULT NULL
)
RETURNS TABLE(
  day DATE,
  api_calls BIGINT,
  live_calls BIGINT,
  estimate_calls BIGINT,
  total_tokens BIGINT,
  live_cost_usd NUMERIC,
  estimate_cost_usd NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (timezone('Asia/Kolkata', u.created_at))::date AS day,
    COUNT(*)::bigint AS api_calls,
    COUNT(*) FILTER (WHERE u.operation <> 'backfill_estimate')::bigint AS live_calls,
    COUNT(*) FILTER (WHERE u.operation = 'backfill_estimate')::bigint AS estimate_calls,
    COALESCE(SUM(u.total_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation <> 'backfill_estimate'), 0)::numeric AS live_cost_usd,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation = 'backfill_estimate'), 0)::numeric AS estimate_cost_usd
  FROM api_usage_events u
  WHERE u.created_at >= p_from
    AND u.created_at < p_to
    AND (p_company_id IS NULL OR u.company_id = p_company_id)
  GROUP BY 1
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION api_usage_monthly_summaries(
  p_company_id UUID DEFAULT NULL
)
RETURNS TABLE(
  month TEXT,
  api_calls BIGINT,
  total_tokens BIGINT,
  live_cost_usd NUMERIC,
  estimate_cost_usd NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    to_char(timezone('Asia/Kolkata', u.created_at), 'YYYY-MM') AS month,
    COUNT(*)::bigint AS api_calls,
    COALESCE(SUM(u.total_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation <> 'backfill_estimate'), 0)::numeric AS live_cost_usd,
    COALESCE(SUM(u.estimated_cost_usd) FILTER (WHERE u.operation = 'backfill_estimate'), 0)::numeric AS estimate_cost_usd
  FROM api_usage_events u
  WHERE p_company_id IS NULL OR u.company_id = p_company_id
  GROUP BY 1
  ORDER BY 1 DESC;
$$;
