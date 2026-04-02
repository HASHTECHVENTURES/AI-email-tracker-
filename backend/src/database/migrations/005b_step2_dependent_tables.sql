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
