#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

# Ensure dependencies exist (no-op if already installed)
if [ ! -d node_modules ]; then
  npm install
fi

exec npm start
