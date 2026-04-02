-- Separate AI report streams: company executive vs department manager.
ALTER TABLE dashboard_reports
  ADD COLUMN IF NOT EXISTS report_scope TEXT NOT NULL DEFAULT 'EXECUTIVE';

ALTER TABLE dashboard_reports
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments (id) ON DELETE CASCADE;

UPDATE dashboard_reports SET report_scope = 'EXECUTIVE' WHERE report_scope IS NULL OR report_scope = '';

CREATE INDEX IF NOT EXISTS idx_dashboard_reports_company_scope_dept_created
  ON dashboard_reports (company_id, report_scope, department_id, created_at DESC);

COMMENT ON COLUMN dashboard_reports.report_scope IS 'EXECUTIVE = CEO company-wide; DEPARTMENT_HEAD = manager scoped';
COMMENT ON COLUMN dashboard_reports.department_id IS 'Set when report_scope = DEPARTMENT_HEAD';
