#!/usr/bin/env bash
# Installiert die Phase-7-Betriebs-Units (Backup täglich, Restore-Test wöchentlich,
# Watchdog minütlich) als systemd-Timer. Idempotent — mehrfach ausführbar.
set -euo pipefail
APP=/opt/gladiator-v2/app

chmod +x "$APP"/deploy/{backup.sh,restore-test.sh,watchdog.sh,notify.sh}

install_unit() {
  local name=$1 desc=$2 exec=$3 cal=$4
  cat > "/etc/systemd/system/${name}.service" <<UNIT
[Unit]
Description=${desc}

[Service]
Type=oneshot
ExecStart=${exec}
UNIT
  cat > "/etc/systemd/system/${name}.timer" <<UNIT
[Unit]
Description=Timer: ${desc}

[Timer]
${cal}
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "${name}.timer"
}

install_unit gladiator-backup "Gladiator v2 Postgres-Backup (taeglich)" "$APP/deploy/backup.sh" "OnCalendar=*-*-* 02:30:00 UTC"
install_unit gladiator-restore-test "Gladiator v2 Restore-Test (woechentlich)" "$APP/deploy/restore-test.sh" "OnCalendar=Sun *-*-* 04:00:00 UTC"
install_unit gladiator-watchdog "Gladiator v2 Health-Watchdog (minuetlich)" "$APP/deploy/watchdog.sh" "OnCalendar=*-*-* *:*:30"

systemctl list-timers 'gladiator-*' --no-pager
echo "OK: Betriebs-Units installiert."
