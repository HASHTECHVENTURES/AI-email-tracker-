#!/usr/bin/env bash
set -euo pipefail

# Run one ingestion cycle. This is safe to call repeatedly.
/usr/bin/curl -fsS "http://127.0.0.1:3000/email-ingestion/run" >/dev/null

