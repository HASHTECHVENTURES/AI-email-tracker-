# Follow-up Monitor Runbook

## Deployment Checklist

- [ ] Rotate and store secrets in a secure secret manager.
- [ ] Update `backend/.env` and `frontend/.env.local`.
- [ ] Ensure backend `INTERNAL_API_KEY` matches:
  - frontend `NEXT_PUBLIC_INTERNAL_API_KEY`
  - launchd ingestion curl header
- [ ] Apply `backend/src/database/schema.sql`.
- [ ] Start backend and frontend.
- [ ] Validate OAuth flow for at least one employee.
- [ ] Trigger one manual ingestion run and confirm no auth/DB errors.

## Health Verification

1. Backend starts without env validation errors.
2. Dashboard API calls succeed with API key.
3. `GET /settings/runtime` shows ingestion state transitions.
4. Ingestion run updates:
   - `mail_sync_state`
   - `email_messages`
   - `conversations`
5. Pending->Missed transition creates one `alerts` row and (if configured) sends Telegram alert.

## Incident: Ingestion Stuck

Symptoms:
- Scheduler logs show repeated `Ingestion cycle is already running`.

Actions:
1. Check `system_settings.ingestion_running`.
2. Check `system_settings.last_ingestion_started_at`.
3. If lock is stale (>30 minutes), rerun ingestion (service auto-reclaims stale lock).

## Incident: Auth Failures (401)

Symptoms:
- API returns unauthorized.

Actions:
1. Confirm frontend and launchd key values match backend `INTERNAL_API_KEY`.
2. Verify request header `x-api-key` is sent.
3. Restart backend after env changes.

## Rollback

1. Stop launchd ingestion job.
2. Revert backend/frontend code to known good version.
3. Re-apply previous SQL snapshot/migration set.
4. Restart backend, run one manual ingestion, then re-enable scheduler.
