DROP FUNCTION IF EXISTS dashboard_global_metrics () CASCADE;
DROP FUNCTION IF EXISTS dashboard_employee_performance () CASCADE;
DROP FUNCTION IF EXISTS dashboard_conversations_list (text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS find_stale_threads () CASCADE;

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
