#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/sujalpatel/Documents/Automation Email "
cd "$ROOT/frontend"

# Ensure dependencies exist (no-op if already installed)
if [ ! -d node_modules ]; then
  npm install
fi

# Build once (fast on subsequent runs), then run like a server on 3001
npm run build
exec npm run start:server

