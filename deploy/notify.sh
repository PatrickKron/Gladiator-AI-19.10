#!/usr/bin/env bash
# Telegram-Notruf für Watchdog/Backup — UNABHÄNGIG vom Node-Prozess.
# Liest TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aus der Server-.env.
# Der kompromittierte v1-Token (7544725601:…) wird verweigert (10_ §1).
set -euo pipefail
MSG="${1:-Gladiator-Alarm (ohne Text)}"
ENV_FILE=/opt/gladiator-v2/app/.env

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "telegram nicht konfiguriert — Alarm nur im Journal: $MSG"
  exit 0
fi
case "$TOKEN" in 7544725601:*)
  echo "VERWEIGERT: kompromittierter v1-Token — Alarm nur im Journal: $MSG"
  exit 0
  ;;
esac

curl -fsS -m 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT}" --data-urlencode text="${MSG}" > /dev/null \
  || echo "Telegram-Versand fehlgeschlagen: $MSG"
