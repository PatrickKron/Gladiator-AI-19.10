#!/usr/bin/env bash
# CI-Lauf auf dem Server: Lint + Typecheck + Migration + Seed + Tests
# gegen die echte TimescaleDB. Wird nach jedem Push ausgeführt (post-receive-Hook),
# kann auch manuell laufen: bash scripts/ci.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

echo "== npm ci =="
npm ci --no-audit --no-fund

echo "== lint =="
npm run lint

echo "== typecheck =="
npm run typecheck

echo "== migrate =="
npm run db:migrate

if [ -d packages/db/seed/data ] && [ -n "$(ls -A packages/db/seed/data 2>/dev/null)" ]; then
  echo "== seed (echte v1-Daten, idempotent) =="
  npm run db:seed
  export EXPECT_SEED=1
else
  echo "== seed übersprungen (keine seed/data vorhanden) =="
fi

echo "== tests =="
npm test

echo "== CI GRUEN =="
