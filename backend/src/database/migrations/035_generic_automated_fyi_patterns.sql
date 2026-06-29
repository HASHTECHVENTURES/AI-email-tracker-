-- Company-neutral FYI cleanup: generic HR/workflow automated patterns (any tenant domain).
-- Replaces product-specific subject literals with portable regex rules.

UPDATE email_messages em
SET relevance_reason = '[LOW] Internal FYI or automated notice — no reply needed.'
FROM employees e
WHERE em.employee_id = e.id
  AND em.direction = 'INBOUND'
  AND lower(trim(em.from_email)) <> lower(trim(e.email))
  AND split_part(lower(trim(em.from_email)), '@', 2) = split_part(lower(trim(e.email)), '@', 2)
  AND em.relevance_reason ILIKE '[NEED_REPLY]%'
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
      AND em.subject ~* '(alert|notification|reminder|digest|activity\s+list|attendance|birthday|approved|processed|ticket\s+update|case\s+update)'
      AND em.subject NOT LIKE '%?%'
      AND COALESCE(em.body_text, '') NOT LIKE '%?%'
    )
  );

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
    em.subject,
    em.from_email,
    e.email AS employee_email
  FROM active_need_reply anr
  JOIN employees e ON e.id = anr.employee_id
  JOIN email_messages em
    ON em.employee_id = anr.employee_id
    AND em.provider_thread_id = anr.provider_thread_id
    AND em.direction = 'INBOUND'
  ORDER BY anr.conversation_id, em.sent_at DESC
),
generic_fyi AS (
  SELECT li.conversation_id
  FROM last_inbound li
  WHERE split_part(lower(trim(li.from_email)), '@', 2) = split_part(lower(trim(li.employee_email)), '@', 2)
    AND (
      li.subject ~* 'attendance\s+(alert|notification|reminder|regulari)'
      OR li.subject ~* '(leave|wfh|work\s*from\s*home).{0,100}(approved|rejected)\s+by'
      OR li.subject ~* '(expense|reimbursement|claim).{0,80}(approved|processed)'
      OR li.subject ~* '(activity|task)\s+list'
      OR li.subject ~* 'daily\s+alert'
      OR li.subject ~* '(overdue|delayed|pending).{0,40}(task|ticket|tracker)'
    )
)
UPDATE conversations c
SET
  follow_up_required = false,
  follow_up_status = 'DONE',
  lifecycle_status = 'RESOLVED',
  priority = 'LOW',
  short_reason = 'Automated workplace notification — no reply needed.',
  reason = 'Automated workplace notification — no reply needed.',
  updated_at = NOW()
FROM generic_fyi gf
WHERE c.conversation_id = gf.conversation_id;
