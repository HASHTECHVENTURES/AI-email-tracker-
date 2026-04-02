-- Gmail ingestion + AI: per-employee tracking flags (extends Step 2 employees)

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS tracking_start_at TIMESTAMPTZ;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS tracking_paused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS sla_hours_default INTEGER;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS exclude_patterns TEXT[] NOT NULL DEFAULT ARRAY[
    'noreply',
    'no-reply',
    'notifications',
    'alerts',
    'mailer-daemon'
  ];
