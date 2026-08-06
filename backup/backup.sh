#!/usr/bin/env bash
# Encrypted restic backup to Oracle Object Storage (+ optional second repo).
# Stops the apps briefly for a consistent copy: stop, rsync to staging, resume, upload.
# Run by the systemd timer (backup/install.sh) or manually: sudo ./backup/backup.sh
# Exit codes: 0 ok, 1 a step or a repo failed, 3 another backup or restore is running.
set -Eeuo pipefail
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
# shellcheck source=backup/lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
trap 'err "Failed at line $LINENO: $BASH_COMMAND"' ERR
take_lock

KEEP=(--keep-daily 7 --keep-weekly 4 --keep-monthly 6)

# Restart the versions that are running, even if versions.env was edited but not applied yet
[ -f "$STACK_DIR/data/versions.applied" ] && export VERSIONS_FILE="$STACK_DIR/data/versions.applied"

# backup_metric 1|0: the result for Grafana, via Alloy's textfile collector; a failed run keeps the previous last success
backup_metric() {
  local d="$STACK_DIR/data/alloy/textfile" now ok=""
  gauge() { printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$2" "$1" "$1" "$3"; }   # NAME HELP VALUE
  now="$(date +%s)"
  mkdir -p "$d" || return 0
  if [ "$1" = 1 ]; then ok="$now"; else ok="$(sed -n 's/^stack_backup_last_success_timestamp_seconds //p' "$d/backup.prom" 2>/dev/null || true)"; fi
  {
    gauge stack_backup_success "1 if the last backup succeeded, 0 if it failed." "$1"
    gauge stack_backup_last_run_timestamp_seconds "When the last backup ended." "$now"
    [ -z "$ok" ] || gauge stack_backup_last_success_timestamp_seconds "When the last successful backup ended." "$ok"
  } > "$d/backup.prom.tmp" && mv "$d/backup.prom.tmp" "$d/backup.prom" || err "Could not write the backup metric"
}

# The stack.sh scopes to stop: apps, if its Compose project has running containers; only what this run stopped is resumed.
# observe keeps running: its only data, data/alloy, is excluded, and Alloy keeps reporting through the copy.
running_scopes() {
  [ -n "$(docker ps -q --filter label=com.docker.compose.project=stack 2>/dev/null)" ] && echo apps
  return 0
}

stopped=()
stop_running() {
  local scopes i
  mapfile -t scopes < <(running_scopes)
  [ "${#scopes[@]}" -gt 0 ] || { log "Nothing is running, copying as is"; return 0; }
  for ((i = ${#scopes[@]} - 1; i >= 0; i--)); do   # stop order: the reverse of start order
    stopped=("${scopes[i]}" "${stopped[@]}")
    "$STACK_DIR/stack.sh" "${scopes[i]}" stop
  done
}
resume_stopped() {
  local s rc=0
  for s in "${stopped[@]}"; do "$STACK_DIR/stack.sh" "$s" resume || rc=1; done
  stopped=()
  return "$rc"
}

cleanup() {
  local rc=$?
  if [ "${#stopped[@]}" -gt 0 ]; then err "Resuming the stack after a failure"; resume_stopped || true; fi
  [ "$rc" = 0 ] || backup_metric 0
}
trap cleanup EXIT

backup_repo() { # $1=PRIMARY|SECONDARY
  local p="$1" rc=0 out
  log "[$p] checking repo"
  out="$(restic_repo "$p" cat config 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" = 10 ]; then   # restic: the repository does not exist
    log "[$p] repo missing, initializing"
    restic_repo "$p" init || return 1
  elif [ "$rc" != 0 ]; then
    err "[$p] cannot open the repo (restic exit $rc): $out"
    return 1
  fi
  log "[$p] backup"
  restic_repo "$p" backup "$STAGING_DIR" --host "$BACKUP_HOST" --tag stack || return 1
  # weekly prune, monthly check: saves API requests (capped on Always Free)
  if [ "$(date +%u)" = 7 ]; then
    log "[$p] forget and prune"
    restic_repo "$p" forget --tag stack --host "$BACKUP_HOST" "${KEEP[@]}" --prune || return 1
  fi
  if [ "$(date +%d)" = 01 ]; then
    log "[$p] check"
    restic_repo "$p" check || return 1
  fi
}

log "Stopping the stack for a consistent snapshot"
stop_running

install -d -m 700 "$STAGING_DIR"
rsync -a --delete --exclude-from="$DIR/excludes.txt" "$STACK_DIR/" "$STAGING_DIR/"

if [ "${#stopped[@]}" -gt 0 ]; then
  resume_stopped
  log "Stack resumed, uploading"
fi

fail=0
for p in PRIMARY SECONDARY; do
  repo_enabled "$p" || continue
  backup_repo "$p" || { err "[$p] FAILED"; fail=1; }
done

if [ "$fail" = 0 ]; then
  backup_metric 1
  log "Done"
else
  exit 1
fi
