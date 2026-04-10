-- Allow the same work email in multiple departments: e.g. manager of support + listed on tech team.
-- Secondary rows are directory-only; mail ingestion skips them (see employees.roster_duplicate).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS roster_duplicate BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN employees.roster_duplicate IS
  'When true, this row is only for org directory / manager visibility; mail sync and Gmail OAuth apply to the primary row (roster_duplicate = false) for this email.';

-- Replace UNIQUE (email, company_id) with uniqueness per department.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_email_company_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS employees_email_company_department_uidx
  ON employees (email, company_id, department_id);
