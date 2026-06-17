-- One-time: move misclassified newsletter/cold-outreach threads out of Need reply.
-- Rule-based fix only — no Gemini API calls.

UPDATE conversations c
SET
  follow_up_required = false,
  follow_up_status = 'DONE',
  priority = 'LOW',
  lifecycle_status = 'RESOLVED',
  short_reason = 'Promotional or cold outreach mail — no reply needed.',
  reason = 'Promotional or cold outreach mail — no reply needed.',
  updated_at = NOW()
WHERE c.conversation_id IN (
  '32846254-08a6-44a5-8798-bd2e927cead5:19ecf01afbb4d227',
  '32846254-08a6-44a5-8798-bd2e927cead5:19ece5de4f7bac0c',
  '32846254-08a6-44a5-8798-bd2e927cead5:19ecb058a28c1bc5',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19eafc58fc8bda46',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ed20fc14386fda',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ed1dcc6a9e80b8',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ed09e4e1d258b1',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ed06ed9be7404b',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ed00915d7ac0db',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ecf3b4c5096728',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ece583ffa10bca',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ecb6720910dae7',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ecb023f8cf20a6',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19eca7a15312cf94',
  'e9fdb8e9-8430-45dc-9ff5-72172c15d2b6:19ec9cb77f6f71fe'
);

UPDATE email_messages
SET relevance_reason = '[LOW] Promotional or cold outreach mail — no reply needed.'
WHERE provider_message_id IN (
  '19ecf01afbb4d227',
  '19ece5de4f7bac0c',
  '19ecb058a28c1bc5',
  '19ed29b6b66c7688',
  '19ed20fc14386fda',
  '19ed1dcc6a9e80b8',
  '19ed09e4e1d258b1',
  '19ed06ed9be7404b',
  '19ed00915d7ac0db',
  '19ecf3b4c5096728',
  '19ece583ffa10bca',
  '19ecb6720910dae7',
  '19ecb023f8cf20a6',
  '19eca7a15312cf94',
  '19ec9cb77f6f71fe'
);

UPDATE email_ingestion_skips
SET
  skip_kind = 'classified_stored',
  skip_reason = '[SKIP] Promotional or cold outreach mail — not a customer reply thread.',
  classification_status = 'skipped',
  skipped_at = NOW()
WHERE provider_message_id IN (
  '19ecf01afbb4d227',
  '19ece5de4f7bac0c',
  '19ecb058a28c1bc5',
  '19ed29b6b66c7688',
  '19ed20fc14386fda',
  '19ed1dcc6a9e80b8',
  '19ed09e4e1d258b1',
  '19ed06ed9be7404b',
  '19ed00915d7ac0db',
  '19ecf3b4c5096728',
  '19ece583ffa10bca',
  '19ecb6720910dae7',
  '19ecb023f8cf20a6',
  '19eca7a15312cf94',
  '19ec9cb77f6f71fe'
);
