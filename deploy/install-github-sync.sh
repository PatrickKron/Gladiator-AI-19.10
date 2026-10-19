#!/usr/bin/env bash
# Installiert den GitHub-Auto-Deploy (deploy/github-sync.sh) als systemd-Timer
# (alle 2 min). Idempotent. Als root auf dem Server ausführen:
#
#   bash /opt/gladiator-v2/app/deploy/install-github-sync.sh <SERVER_REPO>
#
# <SERVER_REPO> = Pfad des Repos, auf das `git push server main` zielt
# (siehe `git remote get-url server` auf dem Windows-Rechner).
#
# Danach den ausgegebenen Public Key bei GitHub eintragen:
#   Repo → Settings → Deploy keys → Add deploy key (NUR lesen, kein Schreibzugriff).
set -euo pipefail
APP=/opt/gladiator-v2/app
SERVER_REPO="${1:?Aufruf: install-github-sync.sh <SERVER_REPO>}"
KEY=/root/.ssh/gladiator_github_deploy
CONF=/etc/gladiator-github-sync.env

git -C "$SERVER_REPO" rev-parse --git-dir > /dev/null \
  || { echo "FEHLER: $SERVER_REPO ist kein Git-Repo."; exit 1; }

chmod +x "$APP/deploy/github-sync.sh"

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "gladiator-server-deploy (read-only)" -f "$KEY" -q
fi
ssh-keygen -F github.com > /dev/null 2>&1 || ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null

if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<CONF
SERVER_REPO=$SERVER_REPO
GITHUB_URL=git@github.com:PatrickKron/Gladiator-AI-19.10.git
DEPLOY_KEY=$KEY
BRANCH=main
CONF
  chmod 600 "$CONF"
fi

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
echo "OK: Timer aktiv. Jetzt diesen Public Key als READ-ONLY Deploy-Key bei GitHub eintragen:"
cat "$KEY.pub"
echo
echo "Test: systemctl start gladiator-github-sync && journalctl -u gladiator-github-sync -n 20"
