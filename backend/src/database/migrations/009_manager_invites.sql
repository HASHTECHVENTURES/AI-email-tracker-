CREATE TABLE IF NOT EXISTS manager_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_invites_company_email_lower
  ON manager_invites (company_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_manager_invites_email_lower ON manager_invites (lower(email));

ALTER TABLE manager_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_manager_invites ON manager_invites;
CREATE POLICY service_role_all_manager_invites
  ON manager_invites
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
