#!/usr/bin/env bash
# Gladiator v2 — lokaler Watchdog (Phase 7): prüft /health minütlich.
# Alarm bei: HTTP-Fehler (Dienst tot) oder degraded=true (Worker still).
# Anti-Spam: höchstens 1 Alarm alle 30 min (State-Datei), Entwarnung bei Erholung.
# HINWEIS (ehrlich): fällt der GANZE Server aus, kann dieser Watchdog nicht
# alarmieren — dafür ist der externe Dead-Man's-Switch (HEALTHCHECKS_URL) da.
set -uo pipefail

STATE=/opt/gladiator-v2/watchdog.state
URL=http://127.0.0.1:3010/health
NOW=$(date +%s)

BODY=$(curl -fsS -m 10 "$URL" 2>/dev/null) || BODY=""
OK=false
if [ -n "$BODY" ]; then
  echo "$BODY" | grep -q '"ok":true' && OK=true
fi

LAST_ALERT=0
WAS_DOWN=no
if [ -f "$STATE" ]; then
  LAST_ALERT=$(sed -n '1p' "$STATE")
  WAS_DOWN=$(sed -n '2p' "$STATE")
fi

if [ "$OK" = true ]; then
  if [ "$WAS_DOWN" = yes ]; then
    /opt/gladiator-v2/app/deploy/notify.sh "🟢 Gladiator wieder gesund (/health ok)." || true
  fi
  printf '%s\nno\n' "$LAST_ALERT" > "$STATE"
  exit 0
fi

DETAIL=${BODY:-"keine Antwort (Dienst tot?)"}
echo "WATCHDOG: /health NICHT ok — $DETAIL"
if [ $((NOW - LAST_ALERT)) -gt 1800 ]; then
  /opt/gladiator-v2/app/deploy/notify.sh "🛑 Gladiator-Watchdog: /health NICHT ok — ${DETAIL:0:300}" || true
  printf '%s\nyes\n' "$NOW" > "$STATE"
else
  printf '%s\nyes\n' "$LAST_ALERT" > "$STATE"
fi
exit 1
