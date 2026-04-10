-- Fast org metrics without loading every conversation row (dashboard metrics, AI report context).
-- Partial index speeds CEO / company-wide lists ordered by updated_at.
CREATE INDEX IF NOT EXISTS idx_conversations_company_active_updated
  ON conversations (company_id, updated_at DESC)
  WHERE is_ignored = false;

CREATE OR REPLACE FUNCTION company_conversation_metrics(
  p_company_id UUID,
  p_department_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'total_conversations', COUNT(*)::bigint,
    'done', COUNT(*) FILTER (WHERE follow_up_status = 'DONE')::bigint,
    'pending', COUNT(*) FILTER (WHERE follow_up_status = 'PENDING')::bigint,
    'missed', COUNT(*) FILTER (WHERE follow_up_status = 'MISSED')::bigint,
    'high_priority_missed', COUNT(*) FILTER (WHERE follow_up_status = 'MISSED' AND priority = 'HIGH')::bigint,
    'avg_delay_hours', COALESCE(AVG(delay_hours)::double precision, 0),
    'needs_attention', COUNT(*) FILTER (WHERE lifecycle_status = 'NEEDS_ATTENTION')::bigint,
    'active', COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::bigint,
    'resolved', COUNT(*) FILTER (WHERE lifecycle_status = 'RESOLVED')::bigint,
    'archived', COUNT(*) FILTER (WHERE lifecycle_status = 'ARCHIVED')::bigint
  )
  FROM conversations
  WHERE company_id = p_company_id
    AND is_ignored = false
    AND (p_department_id IS NULL OR department_id = p_department_id);
$$;

COMMENT ON FUNCTION company_conversation_metrics(UUID, UUID) IS
  'Single-pass aggregates for dashboard GlobalMetrics; optional department_id matches conversation.department_id only.';

GRANT EXECUTE ON FUNCTION company_conversation_metrics(UUID, UUID) TO service_role;
