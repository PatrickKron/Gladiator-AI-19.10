#!/usr/bin/env bash
# Gladiator v2 — automatisierter Restore-Test (Phase 7, B7: „Restore aus Backup getestet").
# Spielt den NEUESTEN Dump in eine Wegwerf-DB ein, prüft echte Zeilenzahlen,
# räumt auf. Fehler ⇒ Telegram-Alarm. Läuft wöchentlich via systemd-Timer.
set -euo pipefail

BACKUP_DIR=/opt/gladiator-v2/backups
CONTAINER=gladiator-postgres
TESTDB=gladiator_restore_test

LATEST=$(ls -1t "$BACKUP_DIR"/gladiator-*.dump 2>/dev/null | head -1 || true)
if [ -z "$LATEST" ]; then
  echo "FEHLER: kein Backup vorhanden." >&2
  /opt/gladiator-v2/app/deploy/notify.sh "🛑 Gladiator-Restore-Test: KEIN Backup vorhanden." || true
  exit 1
fi

cleanup() {
  docker exec "$CONTAINER" psql -U gladiator -d postgres -q -c "DROP DATABASE IF EXISTS $TESTDB (FORCE);" || true
}
trap cleanup EXIT

docker exec "$CONTAINER" psql -U gladiator -d postgres -q -c "DROP DATABASE IF EXISTS $TESTDB (FORCE);"
docker exec "$CONTAINER" psql -U gladiator -d postgres -q -c "CREATE DATABASE $TESTDB;"

# TimescaleDB: Restore-Modus verhindert Hypertable-Trigger-Konflikte
docker exec "$CONTAINER" psql -U gladiator -d "$TESTDB" -q -c "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();"
docker exec -i "$CONTAINER" pg_restore -U gladiator -d "$TESTDB" --no-owner --exit-on-error < "$LATEST"
docker exec "$CONTAINER" psql -U gladiator -d "$TESTDB" -q -c "SELECT timescaledb_post_restore();"

# Ehrliche Integritätsprüfung: echte Kernzahlen müssen > 0 sein
USERS=$(docker exec "$CONTAINER" psql -U gladiator -d "$TESTDB" -tAc "SELECT count(*) FROM users;")
OHLCV=$(docker exec "$CONTAINER" psql -U gladiator -d "$TESTDB" -tAc "SELECT count(*) FROM ohlcv;")
AUDIT=$(docker exec "$CONTAINER" psql -U gladiator -d "$TESTDB" -tAc "SELECT count(*) FROM audit_log;")

if [ "$USERS" -lt 1 ] || [ "$OHLCV" -lt 1000 ] || [ "$AUDIT" -lt 1 ]; then
  echo "FEHLER: Restore-Zahlen unplausibel (users=$USERS ohlcv=$OHLCV audit=$AUDIT)." >&2
  /opt/gladiator-v2/app/deploy/notify.sh "🛑 Gladiator-Restore-Test FEHLGESCHLAGEN (users=$USERS ohlcv=$OHLCV audit=$AUDIT)." || true
  exit 1
fi

echo "OK: Restore-Test bestanden — $(basename "$LATEST") · users=$USERS ohlcv=$OHLCV audit=$AUDIT"
