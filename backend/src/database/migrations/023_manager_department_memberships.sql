-- Many-to-many: department managers (HEAD) can manage multiple teams from one login.
-- users.department_id remains the default / primary team for backward compatibility and migration.

CREATE TABLE IF NOT EXISTS manager_department_memberships (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_dept_memberships_company
  ON manager_department_memberships (company_id);

CREATE INDEX IF NOT EXISTS idx_manager_dept_memberships_dept
  ON manager_department_memberships (department_id);

ALTER TABLE manager_department_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_manager_department_memberships ON manager_department_memberships;
CREATE POLICY service_role_all_manager_department_memberships
  ON manager_department_memberships FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Existing HEAD users keep access to their current team.
INSERT INTO manager_department_memberships (user_id, department_id, company_id)
SELECT u.id, u.department_id, u.company_id
FROM users u
WHERE u.role = 'HEAD'
  AND u.department_id IS NOT NULL
ON CONFLICT (user_id, department_id) DO NOTHING;
