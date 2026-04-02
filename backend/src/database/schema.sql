-- Reference schema after Step 2 (org structure). Apply migrations in order for production DBs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_role') THEN
    CREATE TYPE employee_role AS ENUM ('CEO', 'HEAD', 'EMPLOYEE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_department_id UUID REFERENCES departments (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_departments_company_id ON departments (company_id);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  role employee_role NOT NULL DEFAULT 'EMPLOYEE',
  department_id UUID REFERENCES departments (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_company_id ON users (company_id);

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  tracking_start_at TIMESTAMPTZ,
  tracking_paused BOOLEAN NOT NULL DEFAULT FALSE,
  sla_hours_default INTEGER,
  gmail_status TEXT NOT NULL DEFAULT 'EXPIRED',
  last_synced_at TIMESTAMPTZ,
  exclude_patterns TEXT[] NOT NULL DEFAULT ARRAY[
    'noreply',
    'no-reply',
    'notifications',
    'alerts',
    'mailer-daemon'
  ],
  UNIQUE (email, company_id)
);

CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees (company_id);
CREATE INDEX IF NOT EXISTS idx_employees_department_id ON employees (department_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS linked_employee_id UUID REFERENCES employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_linked_employee_id ON users (linked_employee_id);

CREATE TABLE IF NOT EXISTS employee_oauth_tokens (
  employee_id UUID PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_sync_state (
  employee_id UUID PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE,
  start_date TIMESTAMPTZ NOT NULL,
  last_processed_at TIMESTAMPTZ,
  last_gmail_history_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_messages (
  provider_message_id TEXT PRIMARY KEY,
  provider_thread_id TEXT NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies (id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_emails TEXT[] NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  provider_thread_id TEXT NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies (id) ON DELETE CASCADE,
  department_id UUID REFERENCES departments (id) ON DELETE SET NULL,
  client_name TEXT,
  client_email TEXT,
  last_client_msg_at TIMESTAMPTZ,
  last_employee_reply_at TIMESTAMPTZ,
  follow_up_required BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_status TEXT NOT NULL,
  delay_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  summary TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
  short_reason TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  manually_closed BOOLEAN NOT NULL DEFAULT FALSE,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, provider_thread_id)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content JSONB NOT NULL,
  report_scope TEXT NOT NULL DEFAULT 'EXECUTIVE',
  department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_transition TEXT NOT NULL,
  payload_json JSONB,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  UNIQUE (conversation_id, status_transition)
);

CREATE TABLE IF NOT EXISTS oauth_state_nonces (
  nonce UUID PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_employee_thread_sent_at
  ON email_messages(employee_id, provider_thread_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_ingested_at
  ON email_messages(ingested_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_messages_company_id
  ON email_messages(company_id);

CREATE INDEX IF NOT EXISTS idx_conversations_employee_status_updated
  ON conversations(employee_id, follow_up_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_company_id
  ON conversations(company_id);

CREATE INDEX IF NOT EXISTS idx_conversations_department_id
  ON conversations(department_id);

CREATE INDEX IF NOT EXISTS idx_conversations_lifecycle_updated
  ON conversations(lifecycle_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_employee_sent_at
  ON alerts(employee_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_mail_sync_state_last_processed_at
  ON mail_sync_state(last_processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_oauth_state_nonces_expires_at
  ON oauth_state_nonces(expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_created
  ON audit_logs(company_id, created_at DESC);

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

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_employees ON employees;
CREATE POLICY service_role_all_employees
  ON employees
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_employee_oauth_tokens ON employee_oauth_tokens;
CREATE POLICY service_role_all_employee_oauth_tokens
  ON employee_oauth_tokens
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_mail_sync_state ON mail_sync_state;
CREATE POLICY service_role_all_mail_sync_state
  ON mail_sync_state
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_email_messages ON email_messages;
CREATE POLICY service_role_all_email_messages
  ON email_messages
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_conversations ON conversations;
CREATE POLICY service_role_all_conversations
  ON conversations
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_system_settings ON system_settings;
CREATE POLICY service_role_all_system_settings
  ON system_settings
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_alerts ON alerts;
CREATE POLICY service_role_all_alerts
  ON alerts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_companies ON companies;
CREATE POLICY service_role_all_companies
  ON companies
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_users ON users;
CREATE POLICY service_role_all_users
  ON users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_departments ON departments;
CREATE POLICY service_role_all_departments
  ON departments
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_dashboard_reports ON dashboard_reports;
CREATE POLICY service_role_all_dashboard_reports
  ON dashboard_reports
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_team_alerts ON team_alerts;
CREATE POLICY service_role_all_team_alerts
  ON team_alerts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP FUNCTION IF EXISTS dashboard_global_metrics() CASCADE;
DROP FUNCTION IF EXISTS dashboard_employee_performance() CASCADE;
DROP FUNCTION IF EXISTS dashboard_conversations_list(text,text,text,text) CASCADE;
DROP FUNCTION IF EXISTS find_stale_threads() CASCADE;

CREATE OR REPLACE FUNCTION dashboard_global_metrics ()
RETURNS JSONB
LANGUAGE SQL
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_conversations', COUNT(*)::INT,
    'done', COUNT(*) FILTER (WHERE follow_up_status = 'DONE')::INT,
    'pending', COUNT(*) FILTER (WHERE follow_up_status = 'PENDING')::INT,
    'missed', COUNT(*) FILTER (WHERE follow_up_status = 'MISSED')::INT,
    'high_priority_missed', COUNT(*) FILTER (WHERE follow_up_status = 'MISSED' AND priority = 'HIGH')::INT,
    'avg_delay_hours', COALESCE(ROUND(AVG(delay_hours)::numeric, 2), 0),
    'alerts_sent', (SELECT COUNT(*)::INT FROM alerts),
    'needs_attention', COUNT(*) FILTER (WHERE lifecycle_status = 'NEEDS_ATTENTION')::INT,
    'active', COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::INT,
    'resolved', COUNT(*) FILTER (WHERE lifecycle_status = 'RESOLVED')::INT,
    'archived', COUNT(*) FILTER (WHERE lifecycle_status = 'ARCHIVED')::INT
  )
  FROM conversations
  WHERE is_ignored = false;
$$;

CREATE OR REPLACE FUNCTION dashboard_employee_performance ()
RETURNS TABLE (
  employee_id UUID,
  employee_name TEXT,
  employee_email TEXT,
  total BIGINT,
  done BIGINT,
  pending BIGINT,
  missed BIGINT,
  avg_delay_hours NUMERIC
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    e.id AS employee_id,
    e.name AS employee_name,
    e.email AS employee_email,
    COUNT(c.conversation_id) AS total,
    COUNT(c.conversation_id) FILTER (WHERE c.follow_up_status = 'DONE') AS done,
    COUNT(c.conversation_id) FILTER (WHERE c.follow_up_status = 'PENDING') AS pending,
    COUNT(c.conversation_id) FILTER (WHERE c.follow_up_status = 'MISSED') AS missed,
    COALESCE(ROUND(AVG(c.delay_hours)::numeric, 2), 0) AS avg_delay_hours
  FROM employees e
  LEFT JOIN conversations c ON c.employee_id = e.id AND c.is_ignored = false
  GROUP BY e.id, e.name, e.email
  ORDER BY missed DESC, pending DESC, e.name ASC;
$$;

CREATE OR REPLACE FUNCTION dashboard_conversations_list (
  p_status TEXT DEFAULT NULL,
  p_employee_id TEXT DEFAULT NULL,
  p_priority TEXT DEFAULT NULL,
  p_lifecycle TEXT DEFAULT NULL
)
RETURNS TABLE (
  conversation_id TEXT,
  employee_id UUID,
  employee_name TEXT,
  client_email TEXT,
  follow_up_status TEXT,
  priority TEXT,
  delay_hours NUMERIC,
  summary TEXT,
  short_reason TEXT,
  last_client_msg_at TIMESTAMPTZ,
  last_employee_reply_at TIMESTAMPTZ,
  follow_up_required BOOLEAN,
  confidence NUMERIC,
  lifecycle_status TEXT,
  manually_closed BOOLEAN,
  is_ignored BOOLEAN
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    c.conversation_id,
    c.employee_id,
    e.name AS employee_name,
    c.client_email,
    c.follow_up_status,
    c.priority,
    c.delay_hours,
    c.summary,
    c.short_reason,
    c.last_client_msg_at,
    c.last_employee_reply_at,
    c.follow_up_required,
    c.confidence,
    c.lifecycle_status,
    c.manually_closed,
    c.is_ignored
  FROM conversations c
  JOIN employees e ON e.id = c.employee_id
  WHERE c.is_ignored = false
    AND (p_status IS NULL OR c.follow_up_status = p_status)
    AND (p_employee_id IS NULL OR c.employee_id::text = p_employee_id)
    AND (p_priority IS NULL OR c.priority = p_priority)
    AND (p_lifecycle IS NULL OR c.lifecycle_status = p_lifecycle)
  ORDER BY c.updated_at DESC;
$$;

CREATE OR REPLACE FUNCTION find_stale_threads ()
RETURNS TABLE (
  employee_id UUID,
  provider_thread_id TEXT
)
LANGUAGE SQL
STABLE
AS $$
  WITH latest_msg AS (
    SELECT
      em.employee_id,
      em.provider_thread_id,
      MAX(em.ingested_at) AS last_ingested_at
    FROM email_messages em
    GROUP BY em.employee_id, em.provider_thread_id
  )
  SELECT lm.employee_id, lm.provider_thread_id
  FROM latest_msg lm
  LEFT JOIN conversations c ON c.employee_id = lm.employee_id AND c.provider_thread_id = lm.provider_thread_id
  WHERE c.conversation_id IS NULL OR lm.last_ingested_at > c.updated_at;
$$;
