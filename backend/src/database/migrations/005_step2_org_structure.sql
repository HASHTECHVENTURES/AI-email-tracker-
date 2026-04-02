-- Step 2: org structure — UUID employees, department hierarchy, users.department_id
-- Drops legacy Gmail-era dependent tables and recreates them with UUID employee_id FKs.

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

CREATE TABLE employee_oauth_tokens (
  employee_id UUID PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mail_sync_state (
  employee_id UUID PRIMARY KEY REFERENCES employees (id) ON DELETE CASCADE,
  start_date TIMESTAMPTZ NOT NULL,
  last_processed_at TIMESTAMPTZ,
  last_gmail_history_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE email_messages (
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

CREATE TABLE conversations (
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
  delay_hours NUMERIC(10, 2) NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  summary TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.0,
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
  short_reason TEXT NOT NULL DEFAULT '',
  manually_closed BOOLEAN NOT NULL DEFAULT FALSE,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, provider_thread_id)
);

CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_transition TEXT NOT NULL,
  payload_json JSONB,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  UNIQUE (conversation_id, status_transition)
);

CREATE INDEX IF NOT EXISTS idx_email_messages_employee_thread_sent_at ON email_messages (employee_id, provider_thread_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_ingested_at ON email_messages (ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_company_id ON email_messages (company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_employee_status_updated ON conversations (employee_id, follow_up_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_company_id ON conversations (company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_department_id ON conversations (department_id);
CREATE INDEX IF NOT EXISTS idx_conversations_lifecycle_updated ON conversations (lifecycle_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_employee_sent_at ON alerts (employee_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_sync_state_last_processed_at ON mail_sync_state (last_processed_at DESC);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_employees ON employees;
CREATE POLICY service_role_all_employees ON employees FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_employee_oauth_tokens ON employee_oauth_tokens;
CREATE POLICY service_role_all_employee_oauth_tokens ON employee_oauth_tokens FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_mail_sync_state ON mail_sync_state;
CREATE POLICY service_role_all_mail_sync_state ON mail_sync_state FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_email_messages ON email_messages;
CREATE POLICY service_role_all_email_messages ON email_messages FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_conversations ON conversations;
CREATE POLICY service_role_all_conversations ON conversations FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_role_all_alerts ON alerts;
CREATE POLICY service_role_all_alerts ON alerts FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

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
