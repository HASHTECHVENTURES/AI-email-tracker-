-- Track Cc headers for participation; flag threads where the mailbox was only Cc'd on the latest inbound.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS cc_emails TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_cc_only BOOLEAN NOT NULL DEFAULT FALSE;
