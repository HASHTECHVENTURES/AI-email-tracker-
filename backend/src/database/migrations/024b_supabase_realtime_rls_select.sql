-- Supabase Realtime (postgres_changes): publication + GRANT SELECT + RLS for authenticated.
-- Prerequisite: 024a_employee_role_add_platform_admin.sql applied in a prior transaction.

-- ─── Publication (idempotent) ───────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'companies'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.companies;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'employees'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.employees;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'departments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.departments;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'team_alerts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.team_alerts;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;
END $$;

GRANT SELECT ON TABLE public.companies TO authenticated;
GRANT SELECT ON TABLE public.employees TO authenticated;
GRANT SELECT ON TABLE public.departments TO authenticated;
GRANT SELECT ON TABLE public.team_alerts TO authenticated;
GRANT SELECT ON TABLE public.conversations TO authenticated;

DROP POLICY IF EXISTS authenticated_select_companies_platform_admin ON companies;
CREATE POLICY authenticated_select_companies_platform_admin ON companies
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.role = 'PLATFORM_ADMIN'::employee_role
    )
  );

DROP POLICY IF EXISTS authenticated_select_companies_member ON companies;
CREATE POLICY authenticated_select_companies_member ON companies
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.company_id = companies.id
    )
  );

DROP POLICY IF EXISTS authenticated_select_employees_platform_admin ON employees;
CREATE POLICY authenticated_select_employees_platform_admin ON employees
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.role = 'PLATFORM_ADMIN'::employee_role
    )
  );

DROP POLICY IF EXISTS authenticated_select_employees_ceo ON employees;
CREATE POLICY authenticated_select_employees_ceo ON employees
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role = 'CEO'::employee_role
        AND u.company_id = employees.company_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_employees_head ON employees;
CREATE POLICY authenticated_select_employees_head ON employees
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM manager_department_memberships m
      WHERE m.user_id = auth.uid()
        AND m.department_id = employees.department_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_employees_linked_mailbox ON employees;
CREATE POLICY authenticated_select_employees_linked_mailbox ON employees
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.linked_employee_id = employees.id
    )
  );

DROP POLICY IF EXISTS authenticated_select_departments_platform_admin ON departments;
CREATE POLICY authenticated_select_departments_platform_admin ON departments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.role = 'PLATFORM_ADMIN'::employee_role
    )
  );

DROP POLICY IF EXISTS authenticated_select_departments_same_company ON departments;
CREATE POLICY authenticated_select_departments_same_company ON departments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.company_id = departments.company_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_team_alerts_platform_admin ON team_alerts;
CREATE POLICY authenticated_select_team_alerts_platform_admin ON team_alerts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.role = 'PLATFORM_ADMIN'::employee_role
    )
  );

DROP POLICY IF EXISTS authenticated_select_team_alerts_recipient ON team_alerts;
CREATE POLICY authenticated_select_team_alerts_recipient ON team_alerts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.linked_employee_id = team_alerts.employee_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_team_alerts_ceo ON team_alerts;
CREATE POLICY authenticated_select_team_alerts_ceo ON team_alerts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role = 'CEO'::employee_role
        AND u.company_id = team_alerts.company_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_team_alerts_head ON team_alerts;
CREATE POLICY authenticated_select_team_alerts_head ON team_alerts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM employees e
      INNER JOIN manager_department_memberships m
        ON m.user_id = auth.uid() AND m.department_id = e.department_id
      WHERE e.id = team_alerts.employee_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_conversations_platform_admin ON conversations;
CREATE POLICY authenticated_select_conversations_platform_admin ON conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.role = 'PLATFORM_ADMIN'::employee_role
    )
  );

DROP POLICY IF EXISTS authenticated_select_conversations_ceo ON conversations;
CREATE POLICY authenticated_select_conversations_ceo ON conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role = 'CEO'::employee_role
        AND u.company_id = conversations.company_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_conversations_head ON conversations;
CREATE POLICY authenticated_select_conversations_head ON conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM employees e
      INNER JOIN manager_department_memberships m
        ON m.user_id = auth.uid() AND m.department_id = e.department_id
      WHERE e.id = conversations.employee_id
    )
  );

DROP POLICY IF EXISTS authenticated_select_conversations_linked_mailbox ON conversations;
CREATE POLICY authenticated_select_conversations_linked_mailbox ON conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid() AND u.linked_employee_id = conversations.employee_id
    )
  );
