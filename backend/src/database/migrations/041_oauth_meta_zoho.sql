-- Optional metadata per mailbox OAuth connection (Zoho account id, API datacenter, folder ids).
ALTER TABLE employee_oauth_tokens
  ADD COLUMN IF NOT EXISTS oauth_meta JSONB;

COMMENT ON COLUMN employee_oauth_tokens.oauth_provider IS 'google | microsoft | zoho';
COMMENT ON COLUMN employee_oauth_tokens.oauth_meta IS 'Provider-specific metadata (e.g. Zoho accountId, mail API base URL).';
