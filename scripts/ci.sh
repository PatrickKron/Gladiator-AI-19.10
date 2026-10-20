#!/usr/bin/env bash
# CI-Lauf auf dem Server: Lint + Typecheck + Migration + Seed + Tests
# gegen die echte TimescaleDB. Wird nach jedem Push ausgeführt (post-receive-Hook),
# kann auch manuell laufen: bash scripts/ci.sh
#
# Test-Datenbank (Opt-in): Ist TEST_DATABASE_URL in .env gesetzt (z. B.
# postgres://gladiator:…@127.0.0.1:5433/gladiator_test), laufen Migration, Seed
# und Tests gegen DIESE Datenbank (wird bei Bedarf angelegt); die Live-Datenbank
# wird erst NACH grünen Tests migriert. Ohne die Variable: Verhalten wie bisher.
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

LIVE_DATABASE_URL="${DATABASE_URL:-}"
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "== test-db =="
  node scripts/ensure-test-db.mjs
  export DATABASE_URL="$TEST_DATABASE_URL"
fi

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

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "== migrate (live, erst nach grünen Tests) =="
  DATABASE_URL="$LIVE_DATABASE_URL" npm run db:migrate
fi

echo "== web build =="
npm run build -w web

echo "== CI GRUEN =="
