#!/usr/bin/env bash
# Gladiator v2 — täglicher Postgres-Dump (Phase 7, B7: Backup + Restore-Test).
# Läuft via systemd-Timer (gladiator-backup.timer). Rotation: 14 Dumps.
set -euo pipefail

BACKUP_DIR=/opt/gladiator-v2/backups
CONTAINER=gladiator-postgres
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/gladiator-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Custom-Format-Dump (komprimiert, für pg_restore) aus dem Container
docker exec "$CONTAINER" pg_dump -U gladiator -d gladiator -Fc > "$OUT"

SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 10000 ]; then
  echo "FEHLER: Dump verdächtig klein ($SIZE Bytes) — Backup NICHT vertrauenswürdig." >&2
  /opt/gladiator-v2/app/deploy/notify.sh "🛑 Gladiator-Backup FEHLGESCHLAGEN: Dump nur $SIZE Bytes." || true
  exit 1
fi

# Rotation: nur die letzten 14 behalten
ls -1t "$BACKUP_DIR"/gladiator-*.dump | tail -n +15 | xargs -r rm -f

echo "OK: $OUT ($SIZE Bytes)"
