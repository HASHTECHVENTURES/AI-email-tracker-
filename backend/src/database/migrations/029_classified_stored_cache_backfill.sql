-- Backfill classification cache for mail already in the portal.
-- Survives email_messages DELETE (e.g. date-window cleanup) so re-sync skips Gemini.

INSERT INTO email_ingestion_skips (
  employee_id,
  provider_message_id,
  skip_kind,
  skip_reason,
  classification_status,
  subject,
  from_email,
  sent_at,
  provider_thread_id,
  skipped_at
)
SELECT
  em.employee_id,
  em.provider_message_id,
  'classified_stored',
  em.relevance_reason,
  'classified',
  em.subject,
  em.from_email,
  em.sent_at,
  em.provider_thread_id,
  NOW()
FROM email_messages em
WHERE em.relevance_reason IS NOT NULL
  AND TRIM(em.relevance_reason) <> ''
ON CONFLICT (employee_id, provider_message_id) DO UPDATE SET
  skip_kind = EXCLUDED.skip_kind,
  skip_reason = EXCLUDED.skip_reason,
  classification_status = EXCLUDED.classification_status,
  subject = EXCLUDED.subject,
  from_email = EXCLUDED.from_email,
  sent_at = EXCLUDED.sent_at,
  provider_thread_id = EXCLUDED.provider_thread_id,
  skipped_at = NOW()
WHERE email_ingestion_skips.skip_kind IN ('legacy', 'classified_stored')
   OR email_ingestion_skips.skip_kind IS NULL;
