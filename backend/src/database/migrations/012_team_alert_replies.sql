-- Employee in-app replies to manager team_alerts (threaded).
ALTER TABLE team_alerts
  ADD COLUMN IF NOT EXISTS in_reply_to UUID REFERENCES team_alerts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_team_alerts_in_reply_to
  ON team_alerts(in_reply_to)
  WHERE in_reply_to IS NOT NULL;

COMMENT ON COLUMN team_alerts.in_reply_to IS 'When set, this row is an employee reply to a manager message (parent id).';
