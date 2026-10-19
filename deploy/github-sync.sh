#!/usr/bin/env bash
# Gladiator v2 — GitHub → Server Auto-Deploy (Pull-Modell, kein offener Port,
# kein Server-Schlüssel bei GitHub). Läuft per systemd-Timer (install-github-sync.sh).
#
# Ablauf:
#   1. Spiegel-Repo holt origin/main von GitHub (read-only Deploy-Key).
#   2. Neuer Commit? → Push in das BESTEHENDE Server-Repo (dasselbe Ziel wie
#      `git push server main`). Dessen post-receive-Hook macht wie gewohnt
#      CI (scripts/ci.sh) und startet die Dienste NUR bei grüner CI neu.
#   3. Nur Fast-Forward: hat das Server-Repo Commits, die auf GitHub fehlen,
#      wird NICHT überschrieben — Alarm via notify.sh, Patrick entscheidet.
#
# Konfiguration: /etc/gladiator-github-sync.env (siehe install-github-sync.sh)
#   SERVER_REPO   Pfad des Repos, auf das `git push server main` zielt (Pflicht)
#   GITHUB_URL    z. B. git@github.com:PatrickKron/Gladiator-AI-19.10.git (Pflicht)
#   DEPLOY_KEY    Pfad zum privaten read-only Deploy-Key (Pflicht)
#   BRANCH        Default: main
set -euo pipefail

CONF=/etc/gladiator-github-sync.env
[ -f "$CONF" ] && { set -a; . "$CONF"; set +a; }

: "${SERVER_REPO:?SERVER_REPO fehlt in $CONF (kein Fallback)}"
: "${GITHUB_URL:?GITHUB_URL fehlt in $CONF (kein Fallback)}"
: "${DEPLOY_KEY:?DEPLOY_KEY fehlt in $CONF (kein Fallback)}"
BRANCH="${BRANCH:-main}"
MIRROR=/opt/gladiator-v2/github-mirror.git
NOTIFY=/opt/gladiator-v2/app/deploy/notify.sh
STATE=/opt/gladiator-v2/github-sync.state

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o BatchMode=yes"

# Nie zwei Läufe gleichzeitig (CI im Hook dauert Minuten).
exec 9>/opt/gladiator-v2/github-sync.lock
flock -n 9 || { echo "Sync läuft bereits — übersprungen."; exit 0; }

if [ ! -d "$MIRROR" ]; then
  git init --bare -q "$MIRROR"
  git -C "$MIRROR" remote add github "$GITHUB_URL"
fi

git -C "$MIRROR" fetch -q github "+refs/heads/$BRANCH:refs/remotes/github/$BRANCH"
NEW=$(git -C "$MIRROR" rev-parse "refs/remotes/github/$BRANCH")
CUR=$(git -C "$SERVER_REPO" rev-parse --verify -q "refs/heads/$BRANCH" || echo none)

[ "$NEW" = "$CUR" ] && exit 0

if [ "$CUR" != none ]; then
  # Server-Commit muss im GitHub-Stand enthalten sein (reiner Fast-Forward).
  git -C "$MIRROR" fetch -q "$SERVER_REPO" "+refs/heads/$BRANCH:refs/remotes/server/$BRANCH"
  if ! git -C "$MIRROR" merge-base --is-ancestor "$CUR" "$NEW"; then
    if [ "$(cat "$STATE" 2>/dev/null || true)" != "diverged:$CUR:$NEW" ]; then
      "$NOTIFY" "⚠ Gladiator-Deploy gestoppt: Server-$BRANCH (${CUR:0:7}) und GitHub (${NEW:0:7}) sind auseinandergelaufen. Bitte Server-Commits nach GitHub pushen." || true
      echo "diverged:$CUR:$NEW" > "$STATE"
    fi
    exit 1
  fi
fi

echo "Deploy ${CUR:0:7} → ${NEW:0:7}"
# Löst den bestehenden post-receive-Hook aus (CI + Neustart bei Grün).
if git -C "$MIRROR" push "$SERVER_REPO" "$NEW:refs/heads/$BRANCH"; then
  echo "ok:$NEW" > "$STATE"
else
  if [ "$(cat "$STATE" 2>/dev/null || true)" != "fail:$NEW" ]; then
    "$NOTIFY" "🔴 Gladiator-Deploy ${NEW:0:7} fehlgeschlagen (Push/Hook). Journal: journalctl -u gladiator-github-sync" || true
    echo "fail:$NEW" > "$STATE"
  fi
  exit 1
fi
