-- Gemini inbox relevance: audit / “why tracked” for support and future UI
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS relevance_reason TEXT;

COMMENT ON COLUMN email_messages.relevance_reason IS
  'Short reason from Gemini inbox relevance JSON (why relevant=true or skipped when false).';
