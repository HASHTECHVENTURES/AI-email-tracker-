-- Track which OAuth provider issued tokens for each mailbox (google | microsoft).
ALTER TABLE employee_oauth_tokens
  ADD COLUMN IF NOT EXISTS oauth_provider TEXT NOT NULL DEFAULT 'google';

COMMENT ON COLUMN employee_oauth_tokens.oauth_provider IS 'google = Gmail OAuth; microsoft = Microsoft Graph / O365';
