-- OAuth state one-time nonce store
CREATE TABLE IF NOT EXISTS oauth_state_nonces (
  nonce UUID PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_nonces_expires_at
  ON oauth_state_nonces (expires_at);

-- Conversation-level alert dedupe
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_alert_sent_at TIMESTAMPTZ;

-- Employee Gmail health + sync status
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS gmail_status TEXT NOT NULL DEFAULT 'EXPIRED';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- Basic audit trail
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

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_created
  ON audit_logs (company_id, created_at DESC);
