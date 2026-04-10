-- Resume Gmail messages.list across cron cycles without skipping history (newest-first pagination gap fix).
ALTER TABLE mail_sync_state
  ADD COLUMN IF NOT EXISTS gmail_list_page_token TEXT,
  ADD COLUMN IF NOT EXISTS gmail_list_query_after_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS backfill_max_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN mail_sync_state.gmail_list_page_token IS 'Opaque nextPageToken while a multi-page list walk is in progress';
COMMENT ON COLUMN mail_sync_state.gmail_list_query_after_epoch IS 'Unix seconds used in after: for the in-progress list (must match when resuming)';
COMMENT ON COLUMN mail_sync_state.backfill_max_sent_at IS 'Max sent_at seen while listing; applied to last_processed_at when the list completes';
