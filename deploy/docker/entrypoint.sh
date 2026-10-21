#!/bin/sh
# Container-Start: dieselbe .env wie beim Betrieb ohne Container (Host-Netz, siehe
# docker-compose.yml) — hier wird nichts umgeschrieben und kein Geheimnis erzeugt.
set -eu

: "${DATABASE_URL:?DATABASE_URL fehlt — zuerst npm run setup:env (siehe SELFHOST.md)}"
: "${REDIS_URL:?REDIS_URL fehlt — zuerst npm run setup:env (siehe SELFHOST.md)}"

case "${1:-start}" in
  start)
    npm run db:migrate
    exec npx tsx packages/api/src/start.ts
    ;;
  setup-data)
    exec npm run setup:data
    ;;
  set-password)
    shift
    exec npm run auth:set-password -- "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
