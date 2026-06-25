-- Move internal FYI / auto-notices out of Need reply (false-alarm cleanup).

UPDATE email_messages em
SET relevance_reason = '[LOW] Internal FYI or automated notice — no reply needed.'
FROM employees e
WHERE em.employee_id = e.id
  AND em.direction = 'INBOUND'
  AND lower(trim(em.from_email)) <> lower(trim(e.email))
  AND split_part(lower(trim(em.from_email)), '@', 2) = split_part(lower(trim(e.email)), '@', 2)
  AND em.relevance_reason ILIKE '%internal colleague%'
  AND (
    em.subject ILIKE '%HRMS Attendance Alert%'
    OR em.subject ILIKE '%Process Activity List%'
    OR em.subject ILIKE '%Happy Birthday%'
    OR em.subject ~* '(leave|half cl|casual leave|sick leave).{0,100}approved by'
    OR em.subject ~* 'request by.{0,100}approved by'
    OR (
      split_part(lower(trim(em.from_email)), '@', 1) ~ '^(support|hr|payroll|noreply|no-reply|notifications?|alerts?)$'
      AND (
        em.subject ILIKE '%alert%'
        OR em.subject ILIKE '%notification%'
        OR em.subject ILIKE '%activity list%'
        OR em.subject ILIKE '%attendance%'
        OR em.subject ILIKE '%birthday%'
        OR em.subject ILIKE '%approved by%'
      )
      AND em.subject NOT LIKE '%?%'
      AND COALESCE(em.body_text, '') NOT LIKE '%?%'
    )
  );

UPDATE email_ingestion_skips s
SET
  skip_reason = '[LOW] Internal FYI or automated notice — no reply needed.',
  classification_status = 'classified',
  skipped_at = NOW()
FROM employees e, email_messages em
WHERE s.employee_id = e.id
  AND em.employee_id = e.id
  AND em.provider_message_id = s.provider_message_id
  AND em.relevance_reason = '[LOW] Internal FYI or automated notice — no reply needed.';

UPDATE conversations c
SET
  follow_up_required = false,
  follow_up_status = 'DONE',
  lifecycle_status = 'RESOLVED',
  priority = 'LOW',
  short_reason = 'Internal FYI or automated notice — no reply needed.',
  reason = 'Internal FYI or automated notice — no reply needed.',
  updated_at = NOW()
FROM employees e, email_messages em
WHERE c.employee_id = e.id
  AND em.employee_id = c.employee_id
  AND em.provider_thread_id = c.provider_thread_id
  AND em.direction = 'INBOUND'
  AND c.follow_up_status = 'PENDING'
  AND c.manually_closed = false
  AND c.is_ignored = false
  AND em.relevance_reason = '[LOW] Internal FYI or automated notice — no reply needed.';

-- Gray-area internal threads (no clear ask) — informational, not Need reply.
UPDATE email_messages em
SET relevance_reason = '[LOW] Internal colleague message — informational only.'
FROM employees e
WHERE em.employee_id = e.id
  AND em.direction = 'INBOUND'
  AND lower(trim(em.from_email)) <> lower(trim(e.email))
  AND split_part(lower(trim(em.from_email)), '@', 2) = split_part(lower(trim(e.email)), '@', 2)
  AND em.relevance_reason ILIKE '[NEED_REPLY] Internal colleague%'
  AND em.subject NOT LIKE '%?%'
  AND COALESCE(em.body_text, '') NOT LIKE '%?%'
  AND em.subject !~* '(urgent|asap|action required|approval required|please help|need help|leave query|leave balance|kindly help|please assist|look into|resolve this|fix this)'
  AND COALESCE(em.body_text, '') !~* '(urgent|asap|action required|approval required|please help|need help|leave balance|kindly help|please assist|look into|resolve this|fix this)';

UPDATE email_ingestion_skips s
SET
  skip_reason = '[LOW] Internal colleague message — informational only.',
  classification_status = 'classified',
  skipped_at = NOW()
FROM email_messages em
WHERE s.provider_message_id = em.provider_message_id
  AND s.employee_id = em.employee_id
  AND em.relevance_reason = '[LOW] Internal colleague message — informational only.';

UPDATE conversations c
SET
  follow_up_required = false,
  follow_up_status = 'DONE',
  lifecycle_status = 'RESOLVED',
  priority = 'LOW',
  short_reason = 'Internal colleague message — informational only.',
  reason = 'Internal colleague message — informational only.',
  updated_at = NOW()
FROM email_messages em
WHERE c.employee_id = em.employee_id
  AND c.provider_thread_id = em.provider_thread_id
  AND c.follow_up_status = 'PENDING'
  AND c.manually_closed = false
  AND c.is_ignored = false
  AND em.relevance_reason = '[LOW] Internal colleague message — informational only.';
