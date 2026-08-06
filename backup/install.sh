#!/usr/bin/env bash
# Install the systemd timer (daily at 03:30) and run the first backup.
# Exit codes: 0 installed and the first backup succeeded, 1 error or the first backup failed (the timer stays installed).
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
DIR="$(dirname "$(readlink -f "$0")")"
[ -f "$DIR/backup.env" ] || { echo "Missing backup/backup.env" >&2; exit 1; }
chmod 600 "$DIR/backup.env"
chmod +x "$DIR"/*.sh

sed "s#@BACKUP_SCRIPT@#$DIR/backup.sh#" "$DIR/systemd/stack-backup.service" \
  > /etc/systemd/system/stack-backup.service
cp "$DIR/systemd/stack-backup.timer" /etc/systemd/system/stack-backup.timer
systemctl daemon-reload
systemctl enable --now stack-backup.timer

echo "Running the first backup (may take a few minutes)..."
rc=0
systemctl start stack-backup.service || rc=$?
journalctl -u stack-backup.service -n 40 --no-pager
echo
systemctl list-timers stack-backup.timer --no-pager
if [ "$rc" != 0 ]; then
  echo "The first backup FAILED (log above). The timer is installed; fix it, then: sudo systemctl start stack-backup.service" >&2
  exit 1
fi
