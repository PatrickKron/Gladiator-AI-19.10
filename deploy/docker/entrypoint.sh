#!/bin/sh
# Container-Start: dieselbe .env wie beim Betrieb ohne Container. Nur die Adressen
# von Datenbank und Redis werden auf die Compose-Dienste umgebogen (Port-Angaben
# der .env gelten für den Host). Kein Geheimnis wird hier erzeugt oder ersetzt.
set -eu

: "${DATABASE_URL:?DATABASE_URL fehlt — zuerst npm run setup:env (siehe SELFHOST.md)}"
: "${REDIS_URL:?REDIS_URL fehlt — zuerst npm run setup:env (siehe SELFHOST.md)}"
DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -e 's#@127\.0\.0\.1:5433/#@postgres:5432/#' -e 's#@localhost:5433/#@postgres:5432/#')
REDIS_URL=$(printf '%s' "$REDIS_URL" | sed -e 's#//127\.0\.0\.1:6380#//redis:6379#' -e 's#//localhost:6380#//redis:6379#')
# Im Container auf allen Schnittstellen; nach außen veröffentlicht Compose nur 127.0.0.1
API_HOSTS=0.0.0.0
export DATABASE_URL REDIS_URL API_HOSTS

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
