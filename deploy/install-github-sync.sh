#!/usr/bin/env bash
# Installiert den GitHub-Auto-Deploy (deploy/github-sync.sh) als systemd-Timer
# (alle 2 min). Idempotent. Als root auf dem Server ausführen:
#
#   bash /opt/gladiator-v2/app/deploy/install-github-sync.sh [SERVER_REPO]
#
# SERVER_REPO = Pfad des Repos, auf das `git push server main` zielt. Ohne
# Angabe sucht das Skript es selbst: das Repo, dessen post-receive-Hook
# scripts/ci.sh aufruft. Bei 0 oder mehreren Treffern bricht es ab und
# zeigt die Kandidaten (dann Pfad angeben).
#
# Öffentliches GitHub-Repo → kein Schlüssel nötig. Privates Repo → das Skript
# erzeugt einen Schlüssel; den dann bei GitHub eintragen:
#   Repo → Settings → Deploy keys → Add deploy key (NUR lesen, kein Schreibzugriff).
set -euo pipefail
APP=/opt/gladiator-v2/app
KEY=/root/.ssh/gladiator_github_deploy
CONF=/etc/gladiator-github-sync.env
HTTPS_URL=https://github.com/PatrickKron/Gladiator-AI-19.10.git
SSH_URL=git@github.com:PatrickKron/Gladiator-AI-19.10.git

SERVER_REPO="${1:-}"
if [ -z "$SERVER_REPO" ]; then
  mapfile -t HOOKS < <(find /opt /srv /root /home /var -maxdepth 6 -type f -name post-receive -path '*hooks*' 2>/dev/null \
    | xargs -r grep -l 'ci.sh' 2>/dev/null || true)
  if [ "${#HOOKS[@]}" -ne 1 ]; then
    echo "FEHLER: Server-Repo nicht eindeutig gefunden (${#HOOKS[@]} Treffer):"
    printf '  %s\n' "${HOOKS[@]:-—}"
    echo "Bitte Pfad angeben: bash $0 <SERVER_REPO>   (siehe 'git remote get-url server' unter Windows)"
    exit 1
  fi
  SERVER_REPO=$(dirname "$(dirname "${HOOKS[0]}")")
  echo "Server-Repo gefunden: $SERVER_REPO"
fi

git -C "$SERVER_REPO" rev-parse --git-dir > /dev/null \
  || { echo "FEHLER: $SERVER_REPO ist kein Git-Repo."; exit 1; }

chmod +x "$APP/deploy/github-sync.sh"

# Öffentlich lesbar? Dann HTTPS ohne Schlüssel, sonst read-only Deploy-Key.
NEED_KEY=no
if GIT_TERMINAL_PROMPT=0 git ls-remote "$HTTPS_URL" HEAD > /dev/null 2>&1; then
  GITHUB_URL=$HTTPS_URL
else
  GITHUB_URL=$SSH_URL
  NEED_KEY=yes
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  if [ ! -f "$KEY" ]; then
    ssh-keygen -t ed25519 -N "" -C "gladiator-server-deploy (read-only)" -f "$KEY" -q
  fi
  ssh-keygen -F github.com > /dev/null 2>&1 || ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
fi

cat > "$CONF" <<CONF
SERVER_REPO=$SERVER_REPO
GITHUB_URL=$GITHUB_URL
DEPLOY_KEY=$KEY
BRANCH=main
CONF
chmod 600 "$CONF"

cat > /etc/systemd/system/gladiator-github-sync.service <<UNIT
[Unit]
Description=Gladiator v2 Auto-Deploy von GitHub (main)
After=network-online.target

[Service]
Type=oneshot
ExecStart=$APP/deploy/github-sync.sh
UNIT

cat > /etc/systemd/system/gladiator-github-sync.timer <<UNIT
[Unit]
Description=Timer: Gladiator v2 Auto-Deploy von GitHub

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now gladiator-github-sync.timer

echo
echo "OK: Timer aktiv (alle 2 min). Server-Repo: $SERVER_REPO · Quelle: $GITHUB_URL"
if [ "$NEED_KEY" = yes ]; then
  echo
  echo "Repo ist privat → diesen Public Key bei GitHub als READ-ONLY Deploy-Key eintragen"
  echo "(Repo → Settings → Deploy keys → Add deploy key, Haken bei Schreibzugriff NICHT setzen):"
  echo
  cat "$KEY.pub"
fi
echo
echo "Test: systemctl start gladiator-github-sync && journalctl -u gladiator-github-sync -n 20 --no-pager"
