-- SaaS auth: links Supabase Auth users to companies (run in Supabase SQL editor after auth is enabled)
-- Requires existing public.companies and enum employee_role (see schema.sql)

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role employee_role NOT NULL DEFAULT 'EMPLOYEE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_company_id ON users (company_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_users ON users;
CREATE POLICY service_role_all_users
  ON users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
