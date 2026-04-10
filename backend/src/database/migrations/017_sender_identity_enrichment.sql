-- Persist richer sender identity so follow-up UI can show a real person
-- instead of only generic mailbox addresses.

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS from_name TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_email TEXT;

COMMENT ON COLUMN email_messages.from_name IS
  'Display name parsed from From header (human sender label when available).';
COMMENT ON COLUMN email_messages.reply_to_email IS
  'Reply-To address parsed from Gmail headers; preferred contact email for follow-up identity.';
