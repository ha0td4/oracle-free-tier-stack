# shellcheck shell=bash
# Helpers for backup.sh and restore.sh (sourced).
# sudo on Oracle Linux drops /usr/local/bin, where restic lives
export PATH="/usr/local/sbin:/usr/local/bin:$PATH"
DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck disable=SC2034  # used by backup.sh and restore.sh, which source this file
STACK_DIR="$(dirname "$DIR")"

[ -f "$DIR/backup.env" ] || { echo "Missing $DIR/backup.env (./stack.sh init creates it)" >&2; exit 1; }
# Plain shell variables, not exported: the secrets reach restic only, through restic_repo
# shellcheck source=backup/backup.env.example
. "$DIR/backup.env"
# shellcheck disable=SC2034  # used by backup.sh and restore.sh
STAGING_DIR="${STAGING_DIR:-/var/backups/stack-staging}"
BACKUP_HOST="${BACKUP_HOST:-oracle-stack}"
# systemd sets no HOME, so restic finds no cache dir and fails; one fixed cache also saves bucket requests
RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
LOCK_FILE="${LOCK_FILE:-/run/lock/stack-backup.lock}"

log() { echo "[$(date '+%F %T')] $*"; }
err() { log "$*" >&2; }

# One backup or restore at a time: exit 3 while another holds the lock
take_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || { err "Another backup or restore is running (lock $LOCK_FILE)"; exit 3; }
}

# restic_repo PRIMARY|SECONDARY <args>: each repo has its own S3 credentials. Only restic's process gets them,
# with every RESTIC_* setting of backup.env (password, cache dir, compression...), not the scripts it calls.
restic_repo() {
  local p="$1"; shift
  local repo="${p}_REPOSITORY" key="${p}_AWS_ACCESS_KEY_ID" secret="${p}_AWS_SECRET_ACCESS_KEY" region="${p}_AWS_DEFAULT_REGION"
  (
    for v in $(compgen -v RESTIC_); do export "${v?}"; done
    export RESTIC_REPOSITORY="${!repo}" AWS_ACCESS_KEY_ID="${!key}" AWS_SECRET_ACCESS_KEY="${!secret}" AWS_DEFAULT_REGION="${!region:-auto}"
    exec restic "$@"
  )
}

repo_enabled() { local repo="${1}_REPOSITORY"; [ -n "${!repo:-}" ]; }
