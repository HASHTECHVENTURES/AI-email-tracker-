# Follow-up Monitor Backend

NestJS backend for Gmail ingestion, follow-up classification, and Telegram SLA alerts.

## Security First

1. Rotate all previously exposed credentials before running in any environment.
2. Fill `backend/.env` using `backend/.env.example`.
3. Set a strong random `INTERNAL_API_KEY` (32+ chars).

## Required Environment

See `backend/.env.example` for full template.

Required keys:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`)
- `GEMINI_API_KEY`
- `INTERNAL_API_KEY`

Optional:
- `FRONTEND_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Run

```bash
npm install
npm run start
```

Server starts on `http://0.0.0.0:3000`.

## API Auth

- All non-public routes require `x-api-key: <INTERNAL_API_KEY>` or `Authorization: Bearer <INTERNAL_API_KEY>`.
- Public routes:
  - `GET /auth/google`
  - `GET /auth/google/callback`

## Scheduler

`launchd/com.followupmonitor.ingestion.plist` triggers ingestion every 120 seconds. Update the curl header API key in that plist to match `INTERNAL_API_KEY`.

## Database Bootstrap

Apply `backend/src/database/schema.sql` to Supabase SQL editor. It now includes:
- core tables
- indexes
- RLS policies for service role
- RPC functions used by dashboard/conversation services
# Follow-up Monitoring Backend (MVP)

Rule-first multi-employee follow-up monitoring backend using NestJS patterns.

## Processing pipeline

1. Incremental ingestion fetches only new email messages per employee.
2. Only affected threads are recomputed.
3. Rule engine computes `follow_up_required`, `delay_hours`, and `DONE/PENDING/MISSED` using SLA.
4. AI is called only when rule signals are unclear, returning:

```json
{
  "priority": "LOW | MEDIUM | HIGH",
  "summary": "",
  "confidence": 0.0
}
```

5. Alerts are sent only on `PENDING->MISSED` transition, deduplicated by `(conversation_id, status_transition)`.

## Key guarantees

- Idempotent message ingest via unique `provider_message_id`
- Per-employee sync cursor/timestamp tracking
- Strict employee-level data isolation in thread keys and queries
- OAuth access token refresh support with failure isolation
