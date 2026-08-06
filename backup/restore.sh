#!/usr/bin/env bash
# Restore the stack from a snapshot on a new machine.
# Before: run host/setup-host.sh, copy the repo (or just backup/) to /opt/stack, add backup/backup.env.
# The stack dir is made to match the snapshot (rsync --delete): files the snapshot does not have go, except the paths in
# excludes.txt (.git, caches, metrics and logs), which are kept as they are.
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./backup/restore.sh [--yes] [PRIMARY|SECONDARY] [snapshot-id, default latest]
  --yes, -y   Do not ask before overwriting the stack dir (needed without a terminal)
Exit codes: 0 restored or cancelled, 1 error, 2 usage or no terminal to confirm on, 3 a backup or restore is running.
EOF
}

yes=0
args=()
for a in "$@"; do
  case "$a" in
    -y|--yes) yes=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown flag: $a" >&2; usage >&2; exit 2 ;;
    *) args+=("$a") ;;
  esac
done
[ "${#args[@]}" -le 2 ] || { usage >&2; exit 2; }

[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
# shellcheck source=backup/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
trap 'err "Failed at line $LINENO: $BASH_COMMAND"' ERR
take_lock

REPO="${args[0]:-PRIMARY}"
SNAP="${args[1]:-latest}"
repo_enabled "$REPO" || { err "Repo $REPO is not configured in backup.env"; exit 1; }

log "Snapshots in $REPO:"
restic_repo "$REPO" snapshots --tag stack

if [ "$yes" = 0 ]; then
  [ -t 0 ] || { err "No terminal to confirm on: run it in a terminal, or add --yes to restore without asking"; exit 2; }
  read -r -p "Restore snapshot '$SNAP' and OVERWRITE $STACK_DIR? [y/N] " ans
  [[ $ans == [yY] ]] || { echo "Cancelled."; exit 0; }
fi

# /var/tmp, not /tmp: /tmp is often a small tmpfs (RAM), and a snapshot can be gigabytes
TMP="$(mktemp -d -p /var/tmp stack-restore.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
restic_repo "$REPO" restore "$SNAP" --target "$TMP"

SRC="$TMP$STAGING_DIR"
[ -d "$SRC" ] || { err "$STAGING_DIR not found in the snapshot"; exit 1; }

if [ -f "$STACK_DIR/.env" ]; then "$STACK_DIR/stack.sh" stop || true; fi
# --delete: no current file (a SQLite -wal/-shm, a Postgres file) is left mixed with the restored ones
rsync -a --delete --exclude-from="$DIR/excludes.txt" "$SRC/" "$STACK_DIR/"
log "Restored. Check .env (DOMAIN, STACK_TIER), then run: ./stack.sh up"
log "If the new machine has less RAM: ./stack.sh tier lite"
