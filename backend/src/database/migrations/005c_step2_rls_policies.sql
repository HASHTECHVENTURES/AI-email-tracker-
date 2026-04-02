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
