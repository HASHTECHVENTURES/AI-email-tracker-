-- Persisted Historical Search runs (My Email + dashboard).

CREATE TABLE IF NOT EXISTS historical_search_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  mailbox_name TEXT NOT NULL DEFAULT '',
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  conversation_count INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_historical_search_runs_company_created
  ON historical_search_runs (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_historical_search_runs_employee
  ON historical_search_runs (employee_id, created_at DESC);

ALTER TABLE historical_search_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_historical_search_runs ON historical_search_runs;
CREATE POLICY service_role_all_historical_search_runs
  ON historical_search_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
