-- One-time cleanup: remove ingested mail and conversation rows that fall before each mailbox's
-- product tracking window (`employees.tracking_start_at`). Live tracking is forward-only from
-- that moment; historical ranges use the separate historical fetch flow.
--
-- Safe to re-run: subsequent runs delete 0 rows if already clean.

-- 1) Stored messages before the mailbox's tracking start (only when tracking_start_at is set).
DELETE FROM email_messages em
USING employees e
WHERE em.employee_id = e.id
  AND e.tracking_start_at IS NOT NULL
  AND em.sent_at < e.tracking_start_at;

-- 2) Alerts tied to conversations that no longer have any stored messages for that thread.
DELETE FROM alerts a
USING conversations c, employees e
WHERE a.conversation_id = c.conversation_id
  AND c.employee_id = e.id
  AND e.tracking_start_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM email_messages em
    WHERE em.employee_id = c.employee_id
      AND em.provider_thread_id = c.provider_thread_id
  );

-- 3) Conversation rows with no remaining messages (orphaned threads after step 1).
DELETE FROM conversations c
USING employees e
WHERE c.employee_id = e.id
  AND e.tracking_start_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM email_messages em
    WHERE em.employee_id = c.employee_id
      AND em.provider_thread_id = c.provider_thread_id
  );

-- 4) Refresh last_client_msg_at from remaining INBOUND mail when the column was still pointing
--    at deleted (pre-window) traffic but newer client mail exists in-window.
UPDATE conversations c
SET
  last_client_msg_at = s.max_inbound,
  updated_at = NOW()
FROM (
  SELECT
    employee_id,
    provider_thread_id,
    MAX(sent_at) AS max_inbound
  FROM email_messages
  WHERE direction = 'INBOUND'
  GROUP BY employee_id, provider_thread_id
) s,
  employees e
WHERE c.employee_id = s.employee_id
  AND c.provider_thread_id = s.provider_thread_id
  AND c.employee_id = e.id
  AND e.tracking_start_at IS NOT NULL
  AND c.last_client_msg_at IS NOT NULL
  AND c.last_client_msg_at < e.tracking_start_at
  AND s.max_inbound >= e.tracking_start_at;

-- 5) Align technical sync window with product tracking start; clear list resume so the next
--    ingestion run does not continue an old after: epoch from before the fix.
UPDATE mail_sync_state m
SET
  start_date = e.tracking_start_at,
  gmail_list_page_token = NULL,
  gmail_list_query_after_epoch = NULL,
  backfill_max_sent_at = NULL,
  updated_at = NOW()
FROM employees e
WHERE m.employee_id = e.id
  AND e.tracking_start_at IS NOT NULL
  AND (
    m.start_date < e.tracking_start_at
    OR m.start_date::date = DATE '2020-01-01'
  );
