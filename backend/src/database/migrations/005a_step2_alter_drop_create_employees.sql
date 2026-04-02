ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS parent_department_id UUID REFERENCES departments (id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments (id) ON DELETE SET NULL;

DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS email_messages CASCADE;
DROP TABLE IF EXISTS employee_oauth_tokens CASCADE;
DROP TABLE IF EXISTS mail_sync_state CASCADE;
DROP TABLE IF EXISTS employees CASCADE;

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email, company_id)
);

CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees (company_id);
CREATE INDEX IF NOT EXISTS idx_employees_department_id ON employees (department_id);
