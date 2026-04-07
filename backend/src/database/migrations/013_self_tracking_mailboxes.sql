-- 013: Add mailbox_type to employees for CEO/Manager self-email tracking.
-- 'TEAM' = regular tracked employee mailbox (default, existing behaviour)
-- 'SELF' = CEO or Manager self-tracked mailbox

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS mailbox_type TEXT NOT NULL DEFAULT 'TEAM';

-- Self-tracked mailboxes may not belong to any department.
ALTER TABLE employees
  ALTER COLUMN department_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_mailbox_type
  ON employees (company_id, mailbox_type);
