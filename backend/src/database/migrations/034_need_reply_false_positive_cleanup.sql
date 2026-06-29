-- One-time cleanup: move false-positive Need reply threads out based on last inbound
-- classification and expanded automated-FYI patterns (no Gemini).

-- 1. Reclassify automated FYI messages still marked NEED_REPLY / safety fallback.
UPDATE email_messages em
SET relevance_reason = '[LOW] Internal FYI or automated notice — no reply needed.'
FROM employees e
WHERE em.employee_id = e.id
  AND em.direction = 'INBOUND'
  AND (
    em.relevance_reason ILIKE '[NEED_REPLY]%'
    OR em.relevance_reason ILIKE '%Safety fallback%'
    OR em.relevance_reason ILIKE '%internal colleague%'
  )
  AND (
    em.subject ~* 'attendance\s+(alert|notification|reminder|regulari)'
    OR em.subject ~* '(timesheet|time\s*sheet)\s+(alert|reminder|due|submitted)'
    OR em.subject ~* '(leave|time\s*off|pto|wfh|work\s*from\s*home|half\s*day|casual\s*leave|sick\s*leave).{0,100}(approved|rejected)\s+by'
    OR em.subject ~* '(request|application)\s+by.{0,100}approved\s+by'
    OR em.subject ~* '(expense|reimbursement|claim).{0,80}(approved|processed|submitted)'
    OR em.subject ~* '(activity|task)\s+list'
    OR em.subject ~* '(workflow|process)\s+(activity|notification|reminder)'
    OR em.subject ~* '(overdue|delayed|pending).{0,40}(task|ticket|tracker|item|activit)'
    OR em.subject ~* 'daily\s+alert'
    OR em.subject ~* 'happy\s+birthday'
    OR em.subject ~* '(payroll|payslip|salary)\s+(processed|generated|alert|notification)'
    OR (
      split_part(lower(trim(em.from_email)), '@', 1) ~ '^(support|helpdesk|it-?support|hr|payroll|noreply|no-reply|donotreply|do-not-reply|notifications?|alerts?|notify|system|automated)$'
      AND (
        em.subject ILIKE '%alert%'
        OR em.subject ILIKE '%notification%'
        OR em.subject ILIKE '%activity list%'
        OR em.subject ILIKE '%attendance%'
        OR em.subject ILIKE '%birthday%'
        OR em.subject ILIKE '%approved%'
        OR em.subject ILIKE '%processed%'
      )
      AND em.subject NOT LIKE '%?%'
      AND COALESCE(em.body_text, '') NOT LIKE '%?%'
    )
  );

-- 2. Gray-area internal threads without a clear ask — informational only.
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
  AND em.subject !~* '(urgent|asap|action required|approval required|please help|need help|leave query|leave balance|kindly help|please assist|look into|resolve this|fix this|pending your|awaiting your|do the needful)'
  AND COALESCE(em.body_text, '') !~* '(urgent|asap|action required|approval required|please help|need help|leave balance|kindly help|please assist|look into|resolve this|fix this|pending your|awaiting your|do the needful)';

UPDATE email_ingestion_skips s
SET
  skip_reason = em.relevance_reason,
  classification_status = 'classified',
  skipped_at = NOW()
FROM email_messages em
WHERE s.provider_message_id = em.provider_message_id
  AND s.employee_id = em.employee_id
  AND em.relevance_reason IN (
    '[LOW] Internal FYI or automated notice — no reply needed.',
    '[LOW] Internal colleague message — informational only.'
  );

-- 3. Close active Need reply conversations whose latest inbound does not need a reply.
WITH active_need_reply AS (
  SELECT c.conversation_id, c.employee_id, c.provider_thread_id
  FROM conversations c
  WHERE c.follow_up_required = true
    AND c.manually_closed = false
    AND c.is_ignored = false
    AND c.follow_up_status IN ('PENDING', 'MISSED')
),
last_inbound AS (
  SELECT DISTINCT ON (anr.conversation_id)
    anr.conversation_id,
    em.relevance_reason,
    em.subject
  FROM active_need_reply anr
  JOIN email_messages em
    ON em.employee_id = anr.employee_id
    AND em.provider_thread_id = anr.provider_thread_id
    AND em.direction = 'INBOUND'
  ORDER BY anr.conversation_id, em.sent_at DESC
),
to_close AS (
  SELECT
    li.conversation_id,
    CASE
      WHEN li.relevance_reason ILIKE '[CC]%' THEN 'Mailbox only in CC — no reply expected.'
      WHEN li.relevance_reason ILIKE '[BCC]%' THEN 'Mailbox BCC — informational only.'
      WHEN li.relevance_reason ILIKE '[LOW]%' THEN
        TRIM(regexp_replace(li.relevance_reason, '^\[LOW\]\s*', ''))
      WHEN li.relevance_reason ILIKE '[SKIP]%' OR li.relevance_reason ILIKE '%Safety override%' THEN
        'Promotional or cold outreach mail — no reply needed.'
      WHEN li.relevance_reason ILIKE '%Safety fallback%' THEN
        'Automated or informational notice — no reply needed.'
      WHEN li.subject ~* 'attendance\s+(alert|notification|reminder|regulari)'
        OR li.subject ~* '(activity|task)\s+list'
        OR li.subject ~* 'daily\s+alert'
        OR li.subject ~* '(leave|wfh|work\s*from\s*home).{0,100}(approved|rejected)\s+by'
        OR li.subject ~* '(expense|reimbursement|claim).{0,80}(approved|processed)'
        OR li.subject ~* '(overdue|delayed|pending).{0,40}(task|ticket|tracker)'
        THEN 'Automated workplace notification — no reply needed.'
      ELSE NULL
    END AS close_reason,
    CASE
      WHEN li.relevance_reason ILIKE '[CC]%' THEN 'ACTIVE'
      ELSE 'RESOLVED'
    END AS new_lifecycle,
    CASE
      WHEN li.relevance_reason ILIKE '[CC]%' THEN 'PENDING'
      ELSE 'DONE'
    END AS new_follow_up_status
  FROM last_inbound li
  WHERE
    li.relevance_reason ILIKE '[CC]%'
    OR li.relevance_reason ILIKE '[BCC]%'
    OR li.relevance_reason ILIKE '[LOW]%'
    OR li.relevance_reason ILIKE '[SKIP]%'
    OR li.relevance_reason ILIKE '%Safety override%'
    OR li.relevance_reason ILIKE '%Safety fallback%'
    OR li.subject ~* 'attendance\s+(alert|notification|reminder|regulari)'
    OR li.subject ~* '(activity|task)\s+list'
    OR li.subject ~* 'daily\s+alert'
    OR li.subject ~* '(leave|wfh|work\s*from\s*home).{0,100}(approved|rejected)\s+by'
    OR li.subject ~* '(expense|reimbursement|claim).{0,80}(approved|processed)'
    OR li.subject ~* '(overdue|delayed|pending).{0,40}(task|ticket|tracker)'
)
UPDATE conversations c
SET
  follow_up_required = false,
  follow_up_status = tc.new_follow_up_status,
  lifecycle_status = tc.new_lifecycle,
  priority = 'LOW',
  short_reason = tc.close_reason,
  reason = tc.close_reason,
  updated_at = NOW()
FROM to_close tc
WHERE c.conversation_id = tc.conversation_id
  AND tc.close_reason IS NOT NULL;
