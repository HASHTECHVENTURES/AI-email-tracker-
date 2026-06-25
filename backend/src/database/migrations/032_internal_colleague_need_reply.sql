-- Reclassify same-domain colleague mail from Low/Resolved to Need reply.

UPDATE email_messages em
SET relevance_reason = '[NEED_REPLY] Internal colleague message — reply may be needed.'
FROM employees e
WHERE em.employee_id = e.id
  AND em.direction = 'INBOUND'
  AND lower(trim(em.from_email)) <> lower(trim(e.email))
  AND split_part(lower(trim(em.from_email)), '@', 2) = split_part(lower(trim(e.email)), '@', 2)
  AND (
    em.relevance_reason ILIKE '%internal colleague%'
    OR em.relevance_reason ILIKE '[LOW] Internal colleague%'
  );

UPDATE email_ingestion_skips s
SET
  skip_reason = '[NEED_REPLY] Internal colleague message — reply may be needed.',
  classification_status = 'classified',
  skipped_at = NOW()
FROM employees e
WHERE s.employee_id = e.id
  AND s.skip_reason ILIKE '%internal colleague%';

UPDATE conversations c
SET
  follow_up_required = true,
  follow_up_status = CASE
    WHEN c.last_employee_reply_at IS NULL AND c.last_client_msg_at IS NOT NULL THEN 'PENDING'
    ELSE c.follow_up_status
  END,
  lifecycle_status = 'ACTIVE',
  priority = 'MEDIUM',
  short_reason = 'Internal colleague message — reply may be needed.',
  reason = 'Internal colleague message — reply may be needed.',
  updated_at = NOW()
WHERE (
  c.short_reason ILIKE '%internal colleague%'
  OR c.reason ILIKE '%internal colleague%'
  OR c.conversation_id IN (
    SELECT em.employee_id || ':' || em.provider_thread_id
    FROM email_messages em
    INNER JOIN employees e ON e.id = em.employee_id
    WHERE em.direction = 'INBOUND'
      AND lower(trim(em.from_email)) <> lower(trim(e.email))
      AND split_part(lower(trim(em.from_email)), '@', 2) = split_part(lower(trim(e.email)), '@', 2)
      AND em.relevance_reason ILIKE '%internal colleague%'
  )
)
AND c.manually_closed = false
AND c.is_ignored = false;
