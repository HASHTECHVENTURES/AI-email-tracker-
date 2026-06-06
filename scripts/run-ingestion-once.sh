#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -z "${INTERNAL_API_KEY:-}" ]; then
  echo "INTERNAL_API_KEY is required in $ENV_FILE" >&2
  exit 1
fi

# Run one ingestion cycle. This is safe to call repeatedly.
/usr/bin/curl -fsS \
  -H "x-api-key: ${INTERNAL_API_KEY}" \
  "http://127.0.0.1:3000/email-ingestion/run" >/dev/null
