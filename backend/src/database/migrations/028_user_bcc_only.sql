-- Separate BCC-only threads from CC-only (FYI) in the follow-up portal.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_bcc_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Historical rows were stored with user_cc_only=true when the mailbox was BCC'd.
UPDATE conversations
SET user_bcc_only = TRUE,
    user_cc_only = FALSE
WHERE user_cc_only = TRUE
  AND (short_reason ILIKE '%bcc%' OR reason ILIKE '%bcc%');
