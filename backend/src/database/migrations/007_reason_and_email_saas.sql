-- Explainability: human-readable reason (mirrors rule engine output; kept alongside short_reason for API clarity)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

UPDATE conversations
SET reason = short_reason
WHERE reason = '' OR reason IS NULL;

-- Link login users (EMPLOYEE) to tracked employee row for scoped dashboard
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS linked_employee_id UUID REFERENCES employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_linked_employee_id ON users (linked_employee_id);
