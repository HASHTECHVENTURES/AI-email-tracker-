-- Manager → employee in-app messages (Employee portal)

CREATE TABLE IF NOT EXISTS team_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT team_alerts_body_len CHECK (char_length(body) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_team_alerts_employee_created
  ON team_alerts(employee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_alerts_employee_unread
  ON team_alerts(employee_id)
  WHERE read_at IS NULL;

ALTER TABLE team_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_team_alerts ON team_alerts;
CREATE POLICY service_role_all_team_alerts
  ON team_alerts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
