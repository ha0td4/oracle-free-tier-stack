#!/usr/bin/env bash
# deploy-hub.sh: the monitoring hub without Docker, sized for a 1 GB / 1/8 OCPU VM (Oracle E2.1.Micro).
# Prometheus (metrics), Loki (logs), Tempo (traces), Grafana (dashboards), node_exporter (the hub itself), cloudflared (optional).
# The other hosts push to it over the VCN's private network: Alloy remote-writes to :9090 and pushes logs to :3100; apps send OTLP
# to :4317/:4318. Tailscale stays the admin path (SSH).
#
#   ./deploy-hub.sh dry-run [options]        print what install would change, touch nothing (no root needed)
#   sudo ./deploy-hub.sh install [options]   install or update; idempotent, backs up the current config first
#   sudo ./deploy-hub.sh status              services, versions, memory, disk, retention
#   sudo ./deploy-hub.sh verify [--wait S]   health checks: endpoints, targets, listening addresses, firewall
#   sudo ./deploy-hub.sh backup [--config-only]          archive config (and data) to BACKUP_DIR
#   sudo ./deploy-hub.sh restore FILE [--yes]            put an archive back (config-only or full), restart, verify
#   sudo ./deploy-hub.sh uninstall [--yes]               remove the software and config; keep data and backups
#   sudo ./deploy-hub.sh clear-all [--yes]               remove everything: software, config, data, backups, log
#
# Every setting below can be given as an environment variable (LOGS_RETENTION_DAYS=14 ./deploy-hub.sh install); the ones that
# ./deploy-hub.sh --help lists also have a flag (--logs-retention-days 14). install saves those flag settings, when given by flag or
# environment (never a secret), to /etc/deploy-hub/settings.env and every later run starts from them: a flag wins over the
# environment, the environment over that file, the file over the defaults below. Delete a line there to go back to the default.
# The others (versions, MEM_*, SCRAPE_INTERVAL, LISTEN_ADDR) are not saved: give them again on every run, or edit the defaults.
# Tested on Ubuntu 24.04 (amd64, arm64). Ubuntu 22.04, Debian 12 (apt) and Oracle Linux / RHEL 9-10 (dnf) are best effort.
set -Eeuo pipefail

# --- Settings
readonly SAVED_KEYS=(HUB_NAME HUB_STACK DOMAIN GRAFANA_SUBDOMAIN ADMIN_EMAIL METRICS_RETENTION_DAYS LOGS_RETENTION_DAYS
  TRACES_RETENTION_DAYS PROMETHEUS_RETENTION_SIZE ENABLE_TEMPO TEMPO_METRICS_GENERATOR SWAP_MB ENABLE_ZSWAP TUNE_OS OPEN_FIREWALL
  PUSH_FROM BACKUP_DIR)
declare -A ORIGIN=()
for _k in "${SAVED_KEYS[@]}"; do [ -z "${!_k+x}" ] || ORIGIN[$_k]=environment; done; unset _k
: "${SETTINGS_FILE:=/etc/deploy-hub/settings.env}"  # where install saves them (root only, 600)
: "${HUB_NAME:=observe-hub}"                # host label of the hub's own metrics (use its Tailscale name)
: "${HUB_STACK:=hub}"                         # stack label of the hub's own metrics (the other hosts send theirs: STACK_NAME)
: "${DOMAIN:=}"
: "${GRAFANA_SUBDOMAIN:=monitor}"
: "${ADMIN_EMAIL:=}"                         # the Grafana admin's email: a Pocket ID login with it lands in that account
: "${METRICS_RETENTION_DAYS:=90}"            # Prometheus: 90-day queries take 3-12 s on 1/8 OCPU (measured)
: "${LOGS_RETENTION_DAYS:=90}"               # Loki: 90 days fit 1 GB / 1/8 OCPU once tuned
: "${TRACES_RETENTION_DAYS:=30}"
: "${PROMETHEUS_RETENTION_SIZE:=12GB}"       # the oldest blocks go above this size
: "${SCRAPE_INTERVAL:=60s}"                  # the hub's own scrapes (the hosts' Alloy sets its own)
: "${ENABLE_TEMPO:=0}"
: "${TEMPO_METRICS_GENERATOR:=0}"            # costs RAM
: "${CF_TUNNEL_TOKEN_FILE:=}"
: "${GRAFANA_ADMIN_PASSWORD_FILE:=}"
: "${GRAFANA_OIDC_SECRET_FILE:=}"
: "${DASHBOARDS_DIR:=}"
: "${SWAP_MB:=4096}"
: "${ENABLE_ZSWAP:=1}"                       # compressed swap in RAM before the disk (the biggest win on 1 GB)
: "${TUNE_OS:=1}"                            # journald cap, stop ModemManager, rpcbind, fwupd
: "${OPEN_FIREWALL:=1}"                      # accept the hub's ports from PUSH_FROM (Oracle images drop them otherwise)
: "${PUSH_FROM:=}"
: "${LISTEN_ADDR:=0.0.0.0}"                  # Prometheus, Loki, Tempo OTLP; the firewall keeps them to PUSH_FROM
: "${BACKUP_DIR:=/var/backups/deploy-hub}"   # backup archives (also made automatically before each install)
: "${BACKUP_KEEP:=5}"                        # archives of each kind kept; older ones are deleted
: "${VERIFY_WAIT:=240}"                      # seconds verify waits for slow starts (Grafana takes ~2 min on 1/8 OCPU)
: "${LOG_FILE:=/var/log/deploy-hub.log}"     # every run that changes something is appended here
: "${DRY_RUN:=0}"

# Versions: pinned, the latest releases when this was written. Check the release notes before you change one.
: "${GRAFANA_VERSION:=13.2.4}"               # apt.grafana.com / rpm.grafana.com
: "${LOKI_VERSION:=3.7.9}"
: "${TEMPO_VERSION:=3.1.0}"
: "${PROMETHEUS_VERSION:=3.15.0}"            # GitHub release tarball (distribution packages are older)
: "${NODE_EXPORTER_VERSION:=1.12.1}"

# MEM_* = MemoryHigh:MemoryMax ("-" = none: it would evict the page cache Loki and Prometheus read)
: "${MEM_PROMETHEUS:=-:360M}"
: "${PROM_GOMEMLIMIT_RATIO:=0.45}"           # Prometheus sets its Go limit to this share of MemoryMax (~160 MiB)
: "${MEM_LOKI:=-:460M}"
# Loki keeps ~200 MB of live heap after long queries: a Go limit at 170MiB made it collect non-stop (122% CPU while idle, 30,451 GCs)
: "${GOMEM_LOKI:=280MiB}"
: "${MEM_TEMPO:=200M:300M}"                  # mostly heap: a MemoryHigh is fine here (~170 MB under 20 spans/s)
: "${GOMEM_TEMPO:=160MiB}"
: "${MEM_GRAFANA:=280M:400M}"                # Grafana 13 needs ~250 MB at its first start; below that it swaps until requests time out
: "${GOMEM_GRAFANA:=220MiB}"
: "${MEM_NODE_EXPORTER:=30M:50M}"
: "${GRAFANA_DISABLE_PLUGINS:=elasticsearch,grafana-postgresql-datasource,grafana-pyroscope-datasource,grafana-pyroscope-app,influxdb,jaeger,mssql,mysql,opentsdb,stackdriver,zipkin,cloudwatch,grafana-azure-monitor-datasource,graphite,parca}"  # each backend plugin is a process of its own
: "${CPU_WEIGHT_GRAFANA:=50}"                # below the default 100: ingestion wins over dashboards when the CPU is short

ACTION=""; ASSUME_YES=0; CONFIG_ONLY=0; RESTORE_FILE=""; CHANGED=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  cat <<'EOF'

Options (each one also has the environment variable in brackets; * = install saves it in /etc/deploy-hub/settings.env):
  --dry-run                       show the changes only                       [DRY_RUN=1]
  --hub-name NAME               * host label of the hub (observe-hub)          [HUB_NAME]
  --domain DOMAIN               * Grafana at https://monitor.DOMAIN            [DOMAIN]
  --grafana-subdomain SUB       * Grafana at https://SUB.DOMAIN (monitor)      [GRAFANA_SUBDOMAIN]
  --admin-email EMAIL           * the Grafana admin's email                    [ADMIN_EMAIL]
  --metrics-retention-days N    * Prometheus (90)                              [METRICS_RETENTION_DAYS]
  --logs-retention-days N       * Loki (90)                                    [LOGS_RETENTION_DAYS]
  --traces-retention-days N     * Tempo (30)                                   [TRACES_RETENTION_DAYS]
  --retention-days N            * all three at once
  --prometheus-retention-size S * size cap of Prometheus (12GB)                [PROMETHEUS_RETENTION_SIZE]
  --no-tempo | --tempo          * no traces (the default) | traces             [ENABLE_TEMPO=0|1]
  --tempo-metrics-generator     * span metrics and service graphs              [TEMPO_METRICS_GENERATOR=1]
  --no-tempo-metrics-generator  * back to none (the default)                   [TEMPO_METRICS_GENERATOR=0]
  --tunnel-token-file FILE        cloudflared with this token; later runs keep the installed one [CF_TUNNEL_TOKEN_FILE]
  --grafana-password-file FILE    Grafana admin password                       [GRAFANA_ADMIN_PASSWORD_FILE]
  --grafana-oidc-secret-file FILE Pocket ID login for Grafana (needs --domain)  [GRAFANA_OIDC_SECRET_FILE]
  --dashboards DIR                dashboard JSON to provision                  [DASHBOARDS_DIR]
  --swap-mb N                   * make sure there are N MiB of swap (4096)     [SWAP_MB]
  --push-from CIDR              * the hosts that push (the hub's own subnet)  [PUSH_FROM]
  --no-zswap | --no-os-tuning | --no-firewall                                * [ENABLE_ZSWAP=0 | TUNE_OS=0 | OPEN_FIREWALL=0]
  --zswap | --os-tuning | --firewall           back to the defaults          * [ENABLE_ZSWAP=1 | TUNE_OS=1 | OPEN_FIREWALL=1]
  --backup-dir DIR              * where backups go (/var/backups/deploy-hub)   [BACKUP_DIR]
  --config-only                   backup: config only, no data (seconds, no downtime)
  --wait S                        verify: wait up to S seconds for slow starts [VERIFY_WAIT]
  --yes                           restore, uninstall, clear-all: do not ask
  -h, --help

Exit codes: 0 ok, 1 failed, 2 bad arguments, 3 another run holds the lock.
EOF
}

# need_arg FLAG [VALUE...]: exit 2 when FLAG has no value
need_arg() {
  if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" == -* ]]; then echo "$1 needs a value (see --help)" >&2; exit 2; fi
}
# set_flag KEY VALUE: a setting given by flag (it wins over the environment and the saved settings)
set_flag() { printf -v "$1" '%s' "$2"; ORIGIN[$1]=flag; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      install|uninstall|clear-all|status|verify|backup) ACTION="$1" ;;
      dry-run|plan) ACTION=install; DRY_RUN=1 ;;
      restore) ACTION=restore
        case "${2-}" in
          -*) ;;                                       # an option: no file given, restore lists the archives
          "") [ $# -lt 2 ] || shift ;;                 # an empty argument (e.g. an unset variable)
          *) RESTORE_FILE="$2"; shift ;;
        esac ;;
      --dry-run) DRY_RUN=1 ;;
      --backup-dir) need_arg "$@"; set_flag BACKUP_DIR "$2"; shift ;;
      --config-only) CONFIG_ONLY=1 ;;
      --wait) need_arg "$@"; VERIFY_WAIT="$2"; shift ;;
      --hub-name) need_arg "$@"; set_flag HUB_NAME "$2"; shift ;;
      --domain) need_arg "$@"; set_flag DOMAIN "$2"; shift ;;
      --grafana-subdomain) need_arg "$@"; set_flag GRAFANA_SUBDOMAIN "$2"; shift ;;
      --admin-email) need_arg "$@"; set_flag ADMIN_EMAIL "$2"; shift ;;
      --retention-days) need_arg "$@"
        set_flag METRICS_RETENTION_DAYS "$2"; set_flag LOGS_RETENTION_DAYS "$2"; set_flag TRACES_RETENTION_DAYS "$2"; shift ;;
      --metrics-retention-days) need_arg "$@"; set_flag METRICS_RETENTION_DAYS "$2"; shift ;;
      --logs-retention-days) need_arg "$@"; set_flag LOGS_RETENTION_DAYS "$2"; shift ;;
      --traces-retention-days) need_arg "$@"; set_flag TRACES_RETENTION_DAYS "$2"; shift ;;
      --prometheus-retention-size) need_arg "$@"; set_flag PROMETHEUS_RETENTION_SIZE "$2"; shift ;;
      --no-tempo) set_flag ENABLE_TEMPO 0 ;;
      --tempo) set_flag ENABLE_TEMPO 1 ;;
      --tempo-metrics-generator) set_flag TEMPO_METRICS_GENERATOR 1 ;;
      --no-tempo-metrics-generator) set_flag TEMPO_METRICS_GENERATOR 0 ;;
      --tunnel-token-file) need_arg "$@"; CF_TUNNEL_TOKEN_FILE="$2"; shift ;;
      --grafana-password-file) need_arg "$@"; GRAFANA_ADMIN_PASSWORD_FILE="$2"; shift ;;
      --grafana-oidc-secret-file) need_arg "$@"; GRAFANA_OIDC_SECRET_FILE="$2"; shift ;;
      --dashboards) need_arg "$@"; DASHBOARDS_DIR="$2"; shift ;;
      --swap-mb) need_arg "$@"; set_flag SWAP_MB "$2"; shift ;;
      --no-zswap) set_flag ENABLE_ZSWAP 0 ;;
      --zswap) set_flag ENABLE_ZSWAP 1 ;;
      --no-os-tuning) set_flag TUNE_OS 0 ;;
      --os-tuning) set_flag TUNE_OS 1 ;;
      --push-from) need_arg "$@"; set_flag PUSH_FROM "$2"; shift ;;
      --no-firewall) set_flag OPEN_FIREWALL 0 ;;
      --firewall) set_flag OPEN_FIREWALL 1 ;;
      --yes) ASSUME_YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
  done
  [ -n "$ACTION" ] || { usage >&2; exit 2; }
}

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"; readonly SCRIPT_DIR
readonly STATE_DIR=/var/lib/deploy-hub
readonly MARK="# Managed by host/hub/deploy-hub.sh: run it again instead of editing this file"
readonly CF_UNIT=/etc/systemd/system/cloudflared.service   # written by this script
readonly CF_TOKEN=/etc/cloudflared/token                   # root 600; cloudflared reads it with --token-file
readonly SERVICES=(node_exporter prometheus loki tempo grafana-server)
readonly STOP_ORDER=(grafana-server tempo loki prometheus node_exporter)
readonly ZSWAP_ARGS="zswap.enabled=1 zswap.compressor=lz4 zswap.max_pool_percent=20 zswap.shrinker_enabled=1"

# --- Helpers
# Messages go to stderr. A dry run's "[dry-run]" lines go to fd 3, a copy of stderr that main opens: a command's own
# >/dev/null 2>&1 cannot hide them.
say()  { printf '\n==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
dry()  { [ "$DRY_RUN" = 1 ]; }
# did FUTURE PAST: "would FUTURE" in a dry run, else PAST
did()  { if dry; then printf 'would %s' "$1"; else printf '%s' "$2"; fi; }
swap_mib() { free -m | awk '/^Swap:/{print $2}'; }
# mask: hide the values of passwords, secrets and tokens
mask() { sed -E 's/(^|[^A-Za-z0-9_])([A-Za-z0-9_]*(PASSWORD|SECRET|TOKEN))=.*/\1\2=***/; s/(--token[= ])[^ ]+/\1***/g; s/eyJ[A-Za-z0-9_-]{16,}[A-Za-z0-9_.=-]*/***/g'; }
dryln() { printf '    [dry-run] %s\n' "$*" | mask >&3; }

# run CMD...: execute, or print it in a dry run
run() { if dry; then dryln "$*"; else "$@"; fi; }

# unreadable PATH: PATH exists but this user cannot read it (a dry run without sudo)
unreadable() {
  [ "$(id -u)" != 0 ] || return 1
  if [ -e "$1" ]; then [ ! -r "$1" ]; return; fi
  local e; e="$(LC_ALL=C stat -- "$1" 2>&1 >/dev/null || true)"   # a directory on the way we cannot enter
  [[ "$e" == *"Permission denied"* ]]
}

# put FILE MODE OWNER [CHECK|secret]: write stdin to FILE when it differs. A dry run prints the diff instead (secret: no content).
# CHECK is a function that validates the new file (its path as $1) first: when it fails, nothing is written and the run stops.
put() {
  local f="$1" mode="$2" owner="$3" opt="${4:-}" tmp n
  tmp="$(mktemp)"; cat > "$tmp"
  if dry && unreadable "$f"; then
    dryln "write $f ($mode, $owner): the current file is unreadable without sudo, no diff"; rm -f "$tmp"; return 0
  fi
  if [ -f "$f" ] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; return 0; fi
  if [ -n "$opt" ] && [ "$opt" != secret ] && ! "$opt" "$tmp"; then
    rm -f "$tmp"; die "the new $f is invalid (above): nothing written, the running service keeps its config"
  fi
  if dry; then
    dryln "write $f ($mode, $owner)"
    if [ "$opt" = secret ]; then info "      (secret: content not shown)"
    elif [ -f "$f" ]; then diff -u "$f" "$tmp" | head -40 | sed 's/^/      /' | mask >&3 || true
    else n="$(wc -l < "$tmp")"; head -12 "$tmp" | sed 's/^/      + /' | mask >&3; [ "$n" -le 12 ] || printf '      + ... (%s lines)\n' "$n" >&3; fi
    rm -f "$tmp"; CHANGED+=" $f"; return 0   # so the dry run also shows the restarts it would cause
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner#*:}" "$tmp" "$f"
  rm -f "$tmp"
  CHANGED+=" $f"
}

# check_with TOOL ARGS...: the service's own tool validates a new config for put; skipped while TOOL is not installed
check_with() {
  local out
  have "$1" || { info "($1 is not installed yet: config not checked)"; return 0; }
  out="$("$@" 2>&1)" && return 0
  printf '%s\n' "$out" | tail -20 | sed 's/^/      /' >&2; return 1
}
check_prometheus() { check_with promtool check config "$1"; }
check_loki() { check_with loki -config.file="$1" -verify-config; }
check_tempo() { check_with tempo -config.file="$1" -config.verify=true -config.verify-errors-only=true; }

# --- Saved settings
# load_settings: the values install saved, for each setting no flag or environment variable gave
load_settings() {
  local k v
  SETTINGS_NOTE="none saved yet"
  if unreadable "$SETTINGS_FILE"; then SETTINGS_NOTE="unreadable without sudo: defaults used"
  elif [ -f "$SETTINGS_FILE" ]; then
    SETTINGS_NOTE="$SETTINGS_FILE"
    while IFS='=' read -r k v; do
      case "$k" in ''|\#*) continue ;; esac
      [[ "$k" != *' '* && " ${SAVED_KEYS[*]} " == *" $k "* ]] || { warn "$SETTINGS_FILE: unknown setting $k ignored"; continue; }
      [ -z "${ORIGIN[$k]-}" ] || continue
      printf -v "$k" '%s' "$v"; ORIGIN[$k]=saved
    done < "$SETTINGS_FILE"
  fi
  for k in "${SAVED_KEYS[@]}"; do [ -n "${ORIGIN[$k]-}" ] || ORIGIN[$k]=default; done
}

settings_save() {
  local k body=""
  for k in "${SAVED_KEYS[@]}"; do
    [ "${ORIGIN[$k]}" != default ] || continue
    [[ "${!k}" != *$'\n'* ]] || die "$k contains a line break"
    body+="$k=${!k}"$'\n'
  done
  if [ -z "$body" ] && [ ! -e "$SETTINGS_FILE" ]; then return 0; fi
  put "$SETTINGS_FILE" 600 root:root <<EOF
$MARK
# What install was given by flag or environment variable; later runs start from it (a flag or variable still wins).
# Delete a line to go back to the script's default. Secrets are not kept here: they live in their own root-only files.
${body%$'\n'}
EOF
}

settings_summary() {
  local k out=""
  for k in "${SAVED_KEYS[@]}"; do [ "${ORIGIN[$k]}" = default ] || out+=" $k=${!k} (${ORIGIN[$k]})"; done
  printf '%s' "${out:- all defaults}"
}

changed() { local p; for p in "$@"; do case "$CHANGED" in *"$p"*) return 0 ;; esac; done; return 1; }

have() { command -v "$1" >/dev/null 2>&1; }
svc_exists() { systemctl list-unit-files --no-legend "$1.service" 2>/dev/null | grep -q .; }
state_add() { dry && return 0; mkdir -p "$STATE_DIR"; grep -qxF "$1" "$STATE_DIR/state" 2>/dev/null || echo "$1" >> "$STATE_DIR/state"; }
state_has() { grep -qxF "$1" "$STATE_DIR/state" 2>/dev/null; }
detect_os() {
  # shellcheck source=/dev/null
  . /etc/os-release
  if have apt-get; then PM=apt; elif have dnf; then PM=dnf; else die "Neither apt nor dnf: ${PRETTY_NAME:-unknown OS} is not supported"; fi
  case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "Unsupported architecture $(uname -m)" ;; esac
  if [ "$PM" = apt ]; then GF_ENV=/etc/default/grafana-server; else GF_ENV=/etc/sysconfig/grafana-server; fi
  # The Loki and Tempo packages create their users with no group of their own on Debian/Ubuntu
  SVC_GROUP=nogroup; getent group nogroup >/dev/null || SVC_GROUP=nobody
}

preflight() {
  say "Checks"
  detect_os
  info "OS: ${PRETTY_NAME} | $PM | $ARCH | RAM $(free -m | awk '/^Mem:/{print $2}') MiB | swap $(swap_mib) MiB | free disk $(df -h / | awk 'NR==2{print $4}')"
  [ "$(id -u)" = 0 ] || warn "not root: files only root can read show as unreadable and the saved settings are not read; sudo gives the exact plan"
  info "Settings ($SETTINGS_NOTE):$(settings_summary)"
  local d; for d in "$METRICS_RETENTION_DAYS" "$LOGS_RETENTION_DAYS" "$TRACES_RETENTION_DAYS"; do
    [[ "$d" =~ ^[0-9]+$ ]] && [ "$d" -ge 1 ] || die "retention days must be whole numbers (got $d)"
  done
  [[ "$SWAP_MB" =~ ^[0-9]+$ ]] || die "--swap-mb must be a whole number (got $SWAP_MB)"
  [[ "$HUB_NAME" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$HUB_STACK" =~ ^[A-Za-z0-9._-]+$ ]] || die "hub name and stack: letters, digits, . _ - only"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]*$ ]] && [[ "$GRAFANA_SUBDOMAIN" =~ ^[A-Za-z0-9-]+$ ]] || die "domain and Grafana subdomain: letters, digits, . - only"
  [[ "$ADMIN_EMAIL" =~ ^[^[:space:]]*$ ]] || die "the admin email contains a space"
  [ "$LOGS_RETENTION_DAYS" -le 90 ] || warn "logs kept ${LOGS_RETENTION_DAYS} days: only up to 90 was measured on 1 GB / 1/8 OCPU"
  [ "$SWAP_MB" -gt 0 ] || [ "$(swap_mib)" -ge 1024 ] || warn "less than 1 GB of swap and --swap-mb 0: a 1 GB VM needs 2-4 GB"
  have tailscale || warn "Tailscale is not installed: it is the admin (SSH) path to the hub (DEPLOY.md D8)"
  ls "$DASHBOARDS_DIR"/*.json >/dev/null 2>&1 || die "No dashboard JSON in $DASHBOARDS_DIR (copy config/observe/grafana/dashboards next to the script, or --dashboards DIR)"
  if [ -n "$CF_TUNNEL_TOKEN_FILE" ]; then [ -s "$CF_TUNNEL_TOKEN_FILE" ] || die "$CF_TUNNEL_TOKEN_FILE is empty or missing"; fi
  if [ -n "$GRAFANA_OIDC_SECRET_FILE" ]; then
    [ -s "$GRAFANA_OIDC_SECRET_FILE" ] || die "$GRAFANA_OIDC_SECRET_FILE is empty or missing"
    [ -n "$DOMAIN" ] || die "--grafana-oidc-secret-file needs --domain (Pocket ID is id.DOMAIN)"
  fi
  local cf=skipped
  if [ -n "$CF_TUNNEL_TOKEN_FILE" ]; then cf="on (new token)"; elif [ -f "$CF_UNIT" ]; then cf="on (installed token)"; fi
  info "Retention: metrics ${METRICS_RETENTION_DAYS} d, logs ${LOGS_RETENTION_DAYS} d, traces ${TRACES_RETENTION_DAYS} d | Tempo $([ "$ENABLE_TEMPO" = 1 ] && echo on || echo off) | cloudflared $cf"
}

os_tuning() {
  say "OS tuning"
  local have_swap; have_swap="$(swap_mib)"
  if [ "$SWAP_MB" -gt 0 ] && [ "$have_swap" -lt $(( SWAP_MB * 9 / 10 )) ] && [ ! -e /swapfile-hub ]; then
    local add=$(( SWAP_MB - have_swap ))
    info "swap ${have_swap} MiB: adding /swapfile-hub of ${add} MiB"
    if ! dry; then
      dd if=/dev/zero of=/swapfile-hub bs=1M count="$add" status=none && chmod 600 /swapfile-hub && mkswap /swapfile-hub >/dev/null
      have selinuxenabled && selinuxenabled && chcon -t swapfile_t /swapfile-hub || true
      swapon /swapfile-hub
      grep -q '^/swapfile-hub ' /etc/fstab || echo '/swapfile-hub none swap sw 0 0' >> /etc/fstab
    fi
    state_add swapfile-hub
  fi
  if [ "$ENABLE_ZSWAP" = 1 ]; then
    if [ -d /sys/module/zswap ]; then
      if ! dry; then
        modprobe lz4 2>/dev/null || true
        echo lz4 > /sys/module/zswap/parameters/compressor 2>/dev/null || echo zstd > /sys/module/zswap/parameters/compressor 2>/dev/null || true
        echo 20 > /sys/module/zswap/parameters/max_pool_percent
        # cold compressed pages move on to the disk swap instead of filling the pool
        echo Y > /sys/module/zswap/parameters/shrinker_enabled 2>/dev/null || true
        echo Y > /sys/module/zswap/parameters/enabled
      fi
      info "zswap $(did "be turned" "") on now ($(cat /sys/module/zswap/parameters/compressor 2>/dev/null || echo ?)), and kept across reboots by the kernel command line"
      if [ "$PM" = apt ] && [ -d /etc/default/grub.d ]; then
        put /etc/default/grub.d/90-deploy-hub-zswap.cfg 644 root:root <<EOF
# Managed by host/hub/deploy-hub.sh: compressed swap in RAM before the disk
GRUB_CMDLINE_LINUX_DEFAULT="\$GRUB_CMDLINE_LINUX_DEFAULT $ZSWAP_ARGS"
EOF
        changed /etc/default/grub.d/90-deploy-hub-zswap.cfg && { run update-grub >/dev/null 2>&1 || true; }
      elif have grubby; then
        grubby --info=DEFAULT 2>/dev/null | grep -q 'zswap.enabled=1' || run grubby --update-kernel=ALL --args="$ZSWAP_ARGS"
        state_add grubby-zswap
      fi
    else
      warn "this kernel has no zswap"
    fi
  fi
  if [ "$TUNE_OS" = 1 ]; then
    put /etc/systemd/journald.conf.d/90-deploy-hub.conf 644 root:root <<EOF
$MARK
[Journal]
SystemMaxUse=200M
EOF
    changed /etc/systemd/journald.conf.d/90-deploy-hub.conf && run systemctl restart systemd-journald
    # Swap the cold heap (cheap with zswap) rather than drop the page cache Loki and Prometheus read from; keep the inodes of
    # Loki's many chunk files. 99-zz sorts after host/setup-host.sh's 99-swappiness.conf, which it overrides.
    put /etc/sysctl.d/99-zz-deploy-hub.conf 644 root:root <<EOF
$MARK
vm.swappiness=100
vm.vfs_cache_pressure=50
EOF
    changed /etc/sysctl.d/99-zz-deploy-hub.conf && run sysctl -q -p /etc/sysctl.d/99-zz-deploy-hub.conf
    local s
    for s in ModemManager.service rpcbind.socket rpcbind.service fwupd-refresh.timer; do
      if [ "$(systemctl is-enabled "$s" 2>/dev/null)" = enabled ]; then
        run systemctl disable --now "$s" >/dev/null 2>&1 || true
        state_add "disabled:$s"; info "$(did stop stopped) $s (not needed on the hub; uninstall turns it back on)"
      fi
    done
    if systemctl is-active --quiet fwupd.service 2>/dev/null; then run systemctl stop fwupd.service; fi
  fi
}

# --- Firewall
readonly HUB_PORTS=9090,3100,4317,4318   # Prometheus remote write, Loki push, Tempo OTLP gRPC and HTTP
readonly HUB_PORT_RE='3000|3100|3200|4317|4318|9090|9100'   # every port the hub listens on
readonly PUSH_TAG=deploy-hub-push        # the comment on this script's iptables rule, so a new PUSH_FROM replaces it

# push_net: PUSH_FROM, or the subnet of the interface that holds the default route (on Oracle, the VCN subnet both VMs share)
push_net() {
  local net="$PUSH_FROM" dev
  if [ -z "$net" ]; then
    dev="$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
    [ -z "$dev" ] || net="$(ip -4 route show dev "$dev" proto kernel scope link 2>/dev/null | awk 'NR == 1 { print $1 }')"
  fi
  # /8 at the widest: a typo like 0.0.0.0/0 would open the hub to the Internet
  [[ "$net" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([89]|[12][0-9]|3[0-2])$ ]] || return 1
  printf '%s' "$net"
}

# drop_live_push: delete this script's live iptables rule, whatever PUSH_FROM it was made with
drop_live_push() {
  [ "$(id -u)" = 0 ] || return 0
  local old
  # shellcheck disable=SC2086 # the rule as iptables -S prints it, split back into its words
  while read -r old; do run iptables ${old/#-A /-D }; done < <(iptables -S INPUT 2>/dev/null | grep -F -- "--comment $PUSH_TAG")
}

firewall() {
  [ "$OPEN_FIREWALL" = 1 ] || return 0
  local net
  net="$(push_net)" || die "no subnet found for the hosts that push: give it with --push-from CIDR (your VCN, e.g. 10.0.0.0/16)"
  say "Firewall: ports $HUB_PORTS from $net only"
  if have firewall-cmd && systemctl is-active --quiet firewalld; then
    # A zone of its own: the sources that push, and only the hub's ports
    if ! firewall-cmd --permanent --get-zones | tr ' ' '\n' | grep -qx hub-push; then
      run firewall-cmd --permanent --new-zone=hub-push >/dev/null; state_add firewalld-hub-push
    fi
    local src p
    for src in $(firewall-cmd --permanent --zone=hub-push --list-sources 2>/dev/null); do
      [ "$src" = "$net" ] || run firewall-cmd --permanent --zone=hub-push --remove-source="$src" >/dev/null
    done
    firewall-cmd --permanent --zone=hub-push --query-source="$net" >/dev/null 2>&1 ||
      run firewall-cmd --permanent --zone=hub-push --add-source="$net" >/dev/null
    for p in ${HUB_PORTS//,/ }; do
      firewall-cmd --permanent --zone=hub-push --query-port="$p/tcp" >/dev/null 2>&1 ||
        run firewall-cmd --permanent --zone=hub-push --add-port="$p/tcp" >/dev/null
    done
    run firewall-cmd --reload >/dev/null
    info "firewalld: zone hub-push accepts ports $HUB_PORTS from $net; the public zone opens nothing new"
  elif [ -f /etc/iptables/rules.v4 ]; then
    # Oracle's Ubuntu images: netfilter-persistent with a final REJECT on INPUT
    local spec=(-s "$net" -p tcp -m multiport --dports "$HUB_PORTS" -m comment --comment "$PUSH_TAG" -j ACCEPT)
    local rule="-A INPUT ${spec[*]}"
    if ! grep -qxF -- "$rule" /etc/iptables/rules.v4; then
      run sed -i "/--comment $PUSH_TAG /d" /etc/iptables/rules.v4
      run sed -i "/^-A INPUT -i lo -j ACCEPT\$/a $rule" /etc/iptables/rules.v4
      state_add iptables-hub-push
    fi
    if [ "$(id -u)" != 0 ]; then dryln "iptables: the live rules cannot be read without sudo"
    elif ! iptables -C INPUT "${spec[@]}" 2>/dev/null; then drop_live_push; run iptables -I INPUT "${spec[@]}"; fi
    info "iptables: ports $HUB_PORTS accepted from $net (live and in /etc/iptables/rules.v4); nothing else opened"
  else
    warn "no firewalld and no /etc/iptables/rules.v4: make sure ports $HUB_PORTS are reachable from $net only"
  fi
  info "Tailscale's own rules still let tailnet devices in: a Tailscale ACL limits them (SECURITY.md)"
}

packages() {
  say "Packages: Grafana ${GRAFANA_VERSION}, Loki ${LOKI_VERSION}$([ "$ENABLE_TEMPO" = 1 ] && echo ", Tempo ${TEMPO_VERSION}")"
  local pkgs=("grafana" "loki") vers=("$GRAFANA_VERSION" "$LOKI_VERSION")
  [ "$ENABLE_TEMPO" = 1 ] && { pkgs+=("tempo"); vers+=("$TEMPO_VERSION"); }
  if [ "$PM" = apt ]; then
    if [ ! -f /etc/apt/keyrings/grafana.gpg ]; then
      run install -d -m 755 /etc/apt/keyrings
      if dry; then dryln "fetch https://apt.grafana.com/gpg.key into /etc/apt/keyrings/grafana.gpg"
      else curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/grafana.gpg; fi
    fi
    put /etc/apt/sources.list.d/grafana.list 644 root:root <<'EOF'
deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main
EOF
    local want=() i cur
    for i in "${!pkgs[@]}"; do
      cur="$(dpkg-query -W -f='${Version}' "${pkgs[$i]}" 2>/dev/null || true)"
      [ "${cur%%-*}" = "${vers[$i]}" ] || want+=("${pkgs[$i]}=${vers[$i]}*")
    done
    if [ ${#want[@]} -gt 0 ]; then
      run apt-get update -qq
      run apt-mark unhold "${pkgs[@]}" >/dev/null 2>&1 || true
      info "installing ${want[*]} (a few minutes on 1/8 OCPU)"
      if dry; then dryln "apt-get install -y ${want[*]}"
      else DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --allow-downgrades --allow-change-held-packages -o Dpkg::Options::=--force-confold "${want[@]}" >/dev/null; fi
    else
      info "already at the pinned versions"
    fi
    run apt-mark hold "${pkgs[@]}" >/dev/null
  else
    put /etc/yum.repos.d/grafana.repo 644 root:root <<'EOF'
[grafana]
name=grafana
baseurl=https://rpm.grafana.com
repo_gpgcheck=1
enabled=1
gpgcheck=1
gpgkey=https://rpm.grafana.com/gpg.key
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
EOF
    # dnf 4 (Oracle Linux / RHEL 9 and 10) needs the plugin; dnf5 (Fedora) has versionlock built in
    if [[ "$(dnf --version 2>/dev/null)" != dnf5* ]] && ! rpm -q python3-dnf-plugin-versionlock >/dev/null 2>&1; then
      run dnf -y -q install python3-dnf-plugin-versionlock
    fi
    local specs=() i
    for i in "${!pkgs[@]}"; do rpm -q "${pkgs[$i]}-${vers[$i]}" >/dev/null 2>&1 || specs+=("${pkgs[$i]}-${vers[$i]}"); done
    if [ ${#specs[@]} -gt 0 ]; then
      run dnf versionlock delete "${pkgs[@]}" >/dev/null 2>&1 || true
      run dnf -y -q install "${specs[@]}"
    fi
    run dnf versionlock add "${pkgs[@]}" >/dev/null 2>&1 || true
  fi
}

# fetch_release NAME VERSION URL_BASE TARBALL BINARIES...: a GitHub release into /usr/local/bin, checked against its sha256sums.txt
fetch_release() {
  local name="$1" ver="$2" base="$3" tarball="$4"; shift 4
  if [ -x "/usr/local/bin/$name" ] && "/usr/local/bin/$name" --version 2>&1 | grep -q "version $ver "; then info "$name $ver already installed"; return 0; fi
  info "installing $name $ver (checksum verified)"
  dry && { dryln "download $base/$tarball, check sha256, install $* to /usr/local/bin"; return 0; }
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
  curl -fsSL -o "$tmp/sha256sums.txt" "$base/sha256sums.txt"
  (cd "$tmp" && grep " $tarball\$" sha256sums.txt | sha256sum -c --quiet) || { rm -rf "$tmp"; die "checksum mismatch for $tarball"; }
  tar -xzf "$tmp/$tarball" -C "$tmp"
  local b; for b in "$@"; do install -m 755 "$tmp/${tarball%.tar.gz}/$b" /usr/local/bin/; done
  rm -rf "$tmp"
  CHANGED+=" /usr/local/bin/$name"
}

binaries() {
  say "Binaries: Prometheus ${PROMETHEUS_VERSION}, node_exporter ${NODE_EXPORTER_VERSION}"
  fetch_release prometheus "$PROMETHEUS_VERSION" "https://github.com/prometheus/prometheus/releases/download/v$PROMETHEUS_VERSION" \
    "prometheus-$PROMETHEUS_VERSION.linux-$ARCH.tar.gz" prometheus promtool
  fetch_release node_exporter "$NODE_EXPORTER_VERSION" "https://github.com/prometheus/node_exporter/releases/download/v$NODE_EXPORTER_VERSION" \
    "node_exporter-$NODE_EXPORTER_VERSION.linux-$ARCH.tar.gz" node_exporter
  id prometheus >/dev/null 2>&1 || { run useradd --system --no-create-home --shell /usr/sbin/nologin prometheus; state_add user:prometheus; }
  run install -d -o prometheus -g prometheus -m 750 /var/lib/prometheus
}

# --- Configs
# mem_dropin SERVICE HIGH:MAX [GOMEMLIMIT] [CPUWeight]
mem_dropin() {
  local s="$1" high="${2%%:*}" max="${2#*:}" gomem="${3:-}" cpu="${4:-}"
  put "/etc/systemd/system/$s.service.d/90-deploy-hub.conf" 644 root:root <<EOF
$MARK
[Service]
MemoryHigh=$([ "$high" = - ] && echo infinity || echo "$high")
MemoryMax=$max
$([ -n "$gomem" ] && echo "Environment=GOMEMLIMIT=$gomem")
$([ -n "$cpu" ] && echo "CPUWeight=$cpu")
Restart=on-failure
RestartSec=10
EOF
}

config_prometheus() {
  local tempo_scrape=""
  [ "$ENABLE_TEMPO" = 1 ] && tempo_scrape='  - job_name: tempo
    metric_relabel_configs: *self
    static_configs:
      - targets: ["127.0.0.1:3200"]'
  put /etc/prometheus/prometheus.yml 644 root:root check_prometheus <<EOF
$MARK
# The other hosts push by remote write (Alloy). The scrapes are the hub itself: its host metrics (label host, like Alloy's)
# and its own services, which the Services dashboard shows.
global:
  scrape_interval: $SCRAPE_INTERVAL
  evaluation_interval: $SCRAPE_INTERVAL
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ["127.0.0.1:9100"]
        labels:
          stack: $HUB_STACK
          host: $HUB_NAME
  # The services: the dashboards read only up (never dropped); the Go limits are sized from these three
  - job_name: prometheus
    metric_relabel_configs: &self
      - source_labels: [__name__]
        regex: go_memstats_heap_inuse_bytes|go_gc_duration_seconds_count|process_resident_memory_bytes
        action: keep
    static_configs:
      - targets: ["127.0.0.1:9090"]
  - job_name: loki
    metric_relabel_configs: *self
    static_configs:
      - targets: ["127.0.0.1:3100"]
  - job_name: grafana
    metric_relabel_configs: *self
    static_configs:
      - targets: ["127.0.0.1:3000"]
$tempo_scrape
EOF
  put /etc/systemd/system/prometheus.service 644 root:root <<EOF
$MARK
[Unit]
Description=Prometheus (monitoring hub)
Wants=network-online.target
After=network-online.target
[Service]
User=prometheus
Group=prometheus
ExecStart=/usr/local/bin/prometheus \\
  --config.file=/etc/prometheus/prometheus.yml \\
  --storage.tsdb.path=/var/lib/prometheus \\
  --storage.tsdb.retention.time=${METRICS_RETENTION_DAYS}d \\
  --storage.tsdb.retention.size=$PROMETHEUS_RETENTION_SIZE \\
  --web.listen-address=$LISTEN_ADDR:9090 \\
  --web.enable-remote-write-receiver \\
  --auto-gomemlimit.ratio=$PROM_GOMEMLIMIT_RATIO \\
  --query.max-concurrency=2 \\
  --query.max-samples=5000000 \\
  --query.timeout=1m
ExecReload=/bin/kill -HUP \$MAINPID
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/prometheus
[Install]
WantedBy=multi-user.target
EOF
  mem_dropin prometheus "$MEM_PROMETHEUS"
}

config_node_exporter() {
  put /etc/systemd/system/node_exporter.service 644 root:root <<EOF
$MARK
[Unit]
Description=node_exporter (monitoring hub)
After=network-online.target
[Service]
DynamicUser=yes
ExecStart=/usr/local/bin/node_exporter --web.listen-address=127.0.0.1:9100 \\
  --collector.disable-defaults --collector.cpu --collector.meminfo --collector.filesystem --collector.diskstats \\
  --collector.netdev --collector.loadavg --collector.uname --collector.time --collector.stat \\
  --collector.vmstat --collector.pressure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
[Install]
WantedBy=multi-user.target
EOF
  mem_dropin node_exporter "$MEM_NODE_EXPORTER"
}

config_loki() {
  run install -d -o loki -g "$SVC_GROUP" -m 750 /var/lib/loki
  put /etc/loki/config.yml 644 root:root check_loki <<EOF
$MARK
auth_enabled: false
server:
  http_listen_address: $LISTEN_ADDR
  http_listen_port: 3100
  grpc_listen_address: 127.0.0.1
  grpc_listen_port: 9096
  log_level: warn
  # a cold query over the whole retention takes longer than the 30 s default: it was cut off at ~40 s
  http_server_write_timeout: 150s
  http_server_read_timeout: 150s
common:
  instance_addr: 127.0.0.1
  path_prefix: /var/lib/loki
  replication_factor: 1
  storage:
    filesystem:
      chunks_directory: /var/lib/loki/chunks
      rules_directory: /var/lib/loki/rules
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  retention_period: $(( LOGS_RETENTION_DAYS * 24 ))h
  max_query_length: $(( LOGS_RETENTION_DAYS * 24 + 24 ))h
  # One small node: few sub-queries. Sharding by stream only multiplied the reads (~20 streams per host).
  max_query_parallelism: 2
  tsdb_max_query_parallelism: 2
  split_queries_by_interval: 24h
  max_entries_limit_per_query: 5000
  query_timeout: 2m
  # Per tenant (one tenant; every stack is a label value): a runaway stack cannot flood the hub
  ingestion_rate_mb: 2
  ingestion_burst_size_mb: 4
  per_stream_rate_limit: 512KB
  max_global_streams_per_user: 2000
  volume_enabled: true
  discover_log_levels: false
ingester:
  chunk_encoding: snappy          # gzip (the default) costs much more CPU to decompress on 1/8 OCPU
  chunk_idle_period: 1h           # quiet container streams make fewer, larger chunks
querier:
  max_concurrent: 2
# A query the VM cannot run is refused at once (429) instead of queueing: queued sub-queries of abandoned dashboards kept
# the disk busy for minutes and starved the ingestion in the test
frontend:
  max_outstanding_per_tenant: 64
  log_queries_longer_than: 10s
query_scheduler:
  max_outstanding_requests_per_tenant: 64
compactor:
  working_directory: /var/lib/loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: filesystem
query_range:
  parallelise_shardable_queries: false
  cache_results: true
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 32
# No chunk cache: it would only duplicate the page cache inside the same memory limit
# Recording rules (/var/lib/loki/rules/fake/): per-minute line counts go to Prometheus, so long-range volume panels never read chunks
ruler:
  storage:
    type: local
    local:
      directory: /var/lib/loki/rules
  rule_path: /var/lib/loki/rules-temp
  wal:
    dir: /var/lib/loki/ruler-wal
  evaluation_interval: 1m
  remote_write:
    enabled: true
    clients:
      prometheus:
        url: http://127.0.0.1:9090/api/v1/write
pattern_ingester:
  enabled: false
analytics:
  reporting_enabled: false
EOF
  run install -d -o loki -g "$SVC_GROUP" -m 750 /var/lib/loki/rules /var/lib/loki/rules/fake
  # The lines and error-looking lines per minute, per stack, host and container (or journal unit); 1 min late so lines Alloy
  # buffered for a moment are counted too
  put /var/lib/loki/rules/fake/hub.yaml 644 "loki:$SVC_GROUP" <<'EOF'
# Managed by host/hub/deploy-hub.sh: run it again instead of editing this file
groups:
  - name: log-volume
    interval: 1m
    rules:
      - record: loki:log_lines:count1m
        expr: sum by (stack, host, source, container, unit, level) (count_over_time({source=~"docker|journal"}[1m] offset 1m))
      - record: loki:log_errors:count1m
        expr: sum by (stack, host, source, container, unit) (count_over_time({source=~"docker|journal"} |~ "(?i)(error|fatal|panic|exception)" [1m] offset 1m))
EOF
  mem_dropin loki "$MEM_LOKI" "$GOMEM_LOKI"
}

# Tempo 3: single binary, local storage; retention lives under overrides
config_tempo() {
  [ "$ENABLE_TEMPO" = 1 ] || return 0
  run install -d -o tempo -g "$SVC_GROUP" -m 750 /var/tempo
  local gen="" procs="[]"
  if [ "$TEMPO_METRICS_GENERATOR" = 1 ]; then
    procs="[service-graphs, span-metrics]"
    gen="metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://127.0.0.1:9090/api/v1/write
        send_exemplars: true"
  fi
  put /etc/tempo/config.yml 644 root:root check_tempo <<EOF
$MARK
stream_over_http_enabled: true
server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3200
  grpc_listen_address: 127.0.0.1
  grpc_listen_port: 9097
  log_level: warn
distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: "$LISTEN_ADDR:4317"
        http:
          endpoint: "$LISTEN_ADDR:4318"
$gen
# One small node: few concurrent searches, a short queue, a bounded search window
querier:
  max_concurrent_queries: 2
query_frontend:
  max_outstanding_per_tenant: 100
  search:
    concurrent_jobs: 8
    max_duration: 72h
storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
overrides:
  defaults:
    compaction:
      block_retention: $(( TRACES_RETENTION_DAYS * 24 ))h
    ingestion:
      rate_limit_bytes: 2000000
      burst_size_bytes: 4000000
      max_traces_per_user: 2000
    global:
      max_bytes_per_trace: 2000000
    metrics_generator:
      processors: $procs
usage_report:
  reporting_enabled: false
EOF
  mem_dropin tempo "$MEM_TEMPO" "$GOMEM_TEMPO"
}

# Grafana: settings in its environment file, between markers, so the package's own lines stay
config_grafana() {
  local pw=""
  [ -n "$GRAFANA_ADMIN_PASSWORD_FILE" ] && pw="$(tr -d '\r\n' < "$GRAFANA_ADMIN_PASSWORD_FILE")"
  [ -n "$pw" ] || pw="$(sed -n 's/^GF_SECURITY_ADMIN_PASSWORD=//p' "$GF_ENV" 2>/dev/null | tail -1 || true)"
  # a dry run without sudo cannot read the current one: put says so instead of showing a new password
  if [ -z "$pw" ] && unreadable "$GF_ENV"; then pw="(current)"; fi
  if [ -z "$pw" ]; then pw="$(openssl rand -hex 24)"; GRAFANA_PW_NEW=1; fi
  local root_url=""; [ -n "$DOMAIN" ] && root_url="GF_SERVER_ROOT_URL=https://$GRAFANA_SUBDOMAIN.$DOMAIN"
  # Pocket ID: a new secret from the file, else the one already there; the password form stays as the fallback (/login?disableAutoLogin)
  local oidc="" sec=""
  [ -n "$GRAFANA_OIDC_SECRET_FILE" ] && sec="$(tr -d '\r\n ' < "$GRAFANA_OIDC_SECRET_FILE")"
  [ -n "$sec" ] || sec="$(sed -n 's/^GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=//p' "$GF_ENV" 2>/dev/null | tail -1 || true)"
  if [ -n "$sec" ] && [ -n "$DOMAIN" ]; then
    oidc="GF_AUTH_GENERIC_OAUTH_ENABLED=true
GF_AUTH_OAUTH_AUTO_LOGIN=true
GF_AUTH_GENERIC_OAUTH_NAME=\"Pocket ID\"
GF_AUTH_GENERIC_OAUTH_CLIENT_ID=grafana
GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=$sec
GF_AUTH_GENERIC_OAUTH_SCOPES=\"openid email profile groups\"
GF_AUTH_GENERIC_OAUTH_AUTH_URL=https://id.$DOMAIN/authorize
GF_AUTH_GENERIC_OAUTH_TOKEN_URL=https://id.$DOMAIN/api/oidc/token
GF_AUTH_GENERIC_OAUTH_API_URL=https://id.$DOMAIN/api/oidc/userinfo
GF_AUTH_GENERIC_OAUTH_USE_PKCE=true
GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP=true
GF_AUTH_GENERIC_OAUTH_GROUPS_ATTRIBUTE_PATH=groups
GF_AUTH_GENERIC_OAUTH_ALLOWED_GROUPS=admins
GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH=\"contains(groups[*], 'admins') && 'Admin' || 'Viewer'\"
GF_AUTH_OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP=true"
  elif [ -n "$sec" ]; then
    warn "Grafana has a Pocket ID secret but no domain is set: the Pocket ID login is turned off (--domain DOMAIN keeps it)"
  fi
  local base; base="$(sed '/^# >>> deploy-hub/,/^# <<< deploy-hub/d' "$GF_ENV" 2>/dev/null || true)"
  put "$GF_ENV" 640 root:grafana <<EOF
$base
# >>> deploy-hub (host/hub/deploy-hub.sh rewrites this block)
GF_SERVER_HTTP_ADDR=127.0.0.1
$root_url
GF_SECURITY_ADMIN_USER=admin
$([ -n "$ADMIN_EMAIL" ] && echo "GF_SECURITY_ADMIN_EMAIL=$ADMIN_EMAIL")
GF_SECURITY_ADMIN_PASSWORD=$pw
GF_SECURITY_COOKIE_SECURE=$([ -n "$DOMAIN" ] && echo true || echo false)
GF_SECURITY_DISABLE_GRAVATAR=true
GF_USERS_ALLOW_SIGN_UP=false
GF_AUTH_ANONYMOUS_ENABLED=false
GF_ANALYTICS_REPORTING_ENABLED=false
GF_ANALYTICS_CHECK_FOR_UPDATES=false
GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false
GF_NEWS_NEWS_FEED_ENABLED=false
GF_PLUGINS_PREINSTALL_DISABLED=true
GF_PLUGINS_PREINSTALL_AUTO_UPDATE=false
GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false
GF_PLUGINS_DISABLE_PLUGINS=$GRAFANA_DISABLE_PLUGINS
GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/stack/hosts.json
GF_DATAPROXY_TIMEOUT=120
# 1/8 OCPU: one search-index worker instead of 10 (the first start burst), SQLite in WAL mode (fewer lock waits)
GF_UNIFIED_STORAGE_INDEX_WORKERS=1
GF_UNIFIED_STORAGE_INDEX_REBUILD_WORKERS=1
GF_DATABASE_WAL=true
$oidc
# <<< deploy-hub
EOF
  local tempo_ds=""
  [ "$ENABLE_TEMPO" = 1 ] && tempo_ds='  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://127.0.0.1:3200
    editable: false
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki'
  put /etc/grafana/provisioning/datasources/deploy-hub.yml 644 root:grafana <<EOF
$MARK
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://127.0.0.1:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: 60s
  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://127.0.0.1:3100
    editable: false
    jsonData:
      maxLines: 1000
$tempo_ds
EOF
  put /etc/grafana/provisioning/dashboards/deploy-hub.yml 644 root:grafana <<EOF
$MARK
apiVersion: 1
providers:
  - name: stack
    folder: Stack
    type: file
    disableDeletion: true
    allowUiUpdates: false
    updateIntervalSeconds: 60
    options:
      path: /var/lib/grafana/dashboards/stack
EOF
  run install -d -o grafana -g grafana -m 755 /var/lib/grafana/dashboards/stack
  local j
  for j in "$DASHBOARDS_DIR"/*.json; do put "/var/lib/grafana/dashboards/stack/$(basename "$j")" 644 grafana:grafana < "$j"; done
  mem_dropin grafana-server "$MEM_GRAFANA" "$GOMEM_GRAFANA" "$CPU_WEIGHT_GRAFANA"
}

configs() {
  say "Configs"
  config_prometheus
  config_node_exporter
  config_loki
  config_tempo
  config_grafana
}

# cf_current_token: the token file that the installed cloudflared.service runs with; empty when there is none
cf_current_token() {
  [ -f "$CF_UNIT" ] || return 0
  local f; f="$(sed -nE 's/^ExecStart=.*--token-file[= ]+([^ ]+).*/\1/p' "$CF_UNIT" | head -1)"
  [ -n "$f" ] && tr -d '\r\n ' < "$f" 2>/dev/null || true
}

# The token comes from --tunnel-token-file, else from the cloudflared.service this script wrote,
# else cloudflared is skipped. It stays in a root-only file, never in the process list.
cloudflared_install() {
  local tok="" from=""
  if [ -n "$CF_TUNNEL_TOKEN_FILE" ]; then tok="$(tr -d '\r\n ' < "$CF_TUNNEL_TOKEN_FILE")"; from="$CF_TUNNEL_TOKEN_FILE"
  elif [ -f "$CF_UNIT" ]; then
    from="the installed $CF_UNIT"
    if [ "$(id -u)" = 0 ]; then
      tok="$(cf_current_token)"
      [ -n "$tok" ] || { warn "$CF_UNIT runs without a tunnel token: left as it is (--tunnel-token-file makes this script manage it)"; return 0; }
    else from+=" (its token is unreadable without sudo)"; fi
  else
    return 0
  fi
  say "cloudflared (Grafana through the tunnel: route the public hostname to http://localhost:3000)"
  info "tunnel token from $from"
  [ -z "$tok" ] || [[ "$tok" =~ ^[A-Za-z0-9+/=_-]{20,}$ ]] || die "the tunnel token from $from does not look like one"
  if ! have cloudflared; then
    if [ "$PM" = apt ]; then
      dry || curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      put /etc/apt/sources.list.d/cloudflared.list 644 root:root <<EOF
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${VERSION_CODENAME:-any} main
EOF
      run apt-get update -qq; run apt-get install -y -qq cloudflared
    else
      dry || curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo
      run dnf -y -q install cloudflared
    fi
    state_add cloudflared
  fi
  # no trailing newline: cloudflared reads the file as it is
  [ -z "$tok" ] || printf '%s' "$tok" | put "$CF_TOKEN" 600 root:root secret
  put "$CF_UNIT" 644 root:root <<EOF
$MARK
[Unit]
Description=Cloudflare Tunnel client (monitoring hub)
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
TimeoutStartSec=15
# the token from a root-only file: nothing on the command line
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file $CF_TOKEN
Restart=on-failure
RestartSec=5s
[Install]
WantedBy=multi-user.target
EOF
  state_add cloudflared-unit
  if changed "$CF_UNIT" "$CF_TOKEN" || ! systemctl is-active --quiet cloudflared 2>/dev/null; then
    run systemctl daemon-reload
    run systemctl enable cloudflared >/dev/null 2>&1
    run systemctl restart cloudflared; info "$(did restart restarted) cloudflared (the public URL is down for a few seconds)"
  fi
}

start_all() {
  say "Services"
  run systemctl daemon-reload
  local s list=(node_exporter prometheus loki grafana-server); [ "$ENABLE_TEMPO" = 1 ] && list+=(tempo)
  for s in "${list[@]}"; do
    run systemctl enable "$s" >/dev/null 2>&1
    # changed matches substrings: "/$s" covers the binary, /etc/$s, the unit, its drop-in and GF_ENV (.../grafana-server)
    if ! systemctl is-active --quiet "$s" 2>/dev/null || changed "/$s" ||
       { [ "$s" = grafana-server ] && changed /etc/grafana/provisioning; }; then
      run systemctl restart "$s"; info "$(did restart restarted) $s"
    fi
  done
  if [ "$ENABLE_TEMPO" != 1 ] && svc_exists tempo; then run systemctl disable --now tempo >/dev/null 2>&1 || true; fi
}

install_all() {
  preflight
  # An install over an existing one keeps a config backup first, so a bad change can be undone with restore
  if ! dry && [ -f "$STATE_DIR/state" ]; then CONFIG_ONLY=1 backup_make pre-install; fi
  state_add installed
  settings_save
  os_tuning
  firewall
  packages
  binaries
  configs
  cloudflared_install
  start_all
  dry && { say "Dry run: nothing was changed"; return 0; }
  say "Done"
  [ "${GRAFANA_PW_NEW:-0}" = 1 ] && info "Grafana admin password generated: sudo grep ^GF_SECURITY_ADMIN_PASSWORD= $GF_ENV (save it in your password manager)"
  info "Check it: sudo bash $0 verify"
}

# --- Status / verify
readonly CONFIG_PATHS=(/etc/prometheus /etc/loki /etc/tempo /etc/grafana /etc/default/grafana-server /etc/sysconfig/grafana-server
  /etc/systemd/system/prometheus.service /etc/systemd/system/node_exporter.service
  /etc/systemd/system/prometheus.service.d /etc/systemd/system/node_exporter.service.d /etc/systemd/system/loki.service.d
  /etc/systemd/system/tempo.service.d /etc/systemd/system/grafana-server.service.d
  /etc/systemd/journald.conf.d/90-deploy-hub.conf /etc/sysctl.d/99-zz-deploy-hub.conf /etc/default/grub.d/90-deploy-hub-zswap.cfg
  /etc/deploy-hub /etc/cloudflared "$CF_UNIT"
  /var/lib/loki/rules /var/lib/deploy-hub)
readonly DATA_PATHS=(/var/lib/prometheus /var/lib/loki /var/tempo /var/lib/grafana)

status_all() {
  detect_os
  say "Services"
  local s pid
  for s in "${SERVICES[@]}" cloudflared; do
    svc_exists "$s" || continue
    pid="$(systemctl show -p MainPID --value "$s")"
    printf '    %-15s %-10s mem %5s MiB  swap %5s MiB\n' "$s" "$(systemctl is-active "$s")" \
      "$(( $(systemctl show -p MemoryCurrent --value "$s" 2>/dev/null | grep -E '^[0-9]+$' || echo 0) / 1048576 ))" \
      "$( [ "$pid" -gt 0 ] 2>/dev/null && awk '/VmSwap/{print int($2/1024)}' "/proc/$pid/status" || echo -)"
  done
  say "Versions"
  /usr/local/bin/prometheus --version 2>&1 | head -1 | sed 's/^/    /' || true
  /usr/local/bin/node_exporter --version 2>&1 | head -1 | sed 's/^/    /' || true
  if [ "$PM" = apt ]; then dpkg-query -W -f='    ${Package} ${Version}\n' grafana loki tempo cloudflared 2>/dev/null || true
  else rpm -q grafana loki tempo cloudflared 2>/dev/null | sed 's/^/    /' || true; fi
  say "Data, memory, retention"
  du -sh "${DATA_PATHS[@]}" 2>/dev/null | sed 's/^/    /' || true
  free -m | sed 's/^/    /'
  printf '    zswap: %s\n' "$(cat /sys/module/zswap/parameters/enabled 2>/dev/null || echo n/a)"
  grep -o 'retention.time=[^ ]*' /etc/systemd/system/prometheus.service 2>/dev/null | sed 's/^/    prometheus /' || true
  grep -o 'retention_period: .*' /etc/loki/config.yml 2>/dev/null | sed 's/^/    loki /' || true
  grep -o 'block_retention: .*' /etc/tempo/config.yml 2>/dev/null | sed 's/^/    tempo /' || true
  say "Settings (saved: $SETTINGS_NOTE; a flag wins over the environment, the environment over the saved file)"
  local k; for k in "${SAVED_KEYS[@]}"; do printf '    %-26s %-28s %s\n' "$k" "${!k:-(empty)}" "${ORIGIN[$k]}"; done
  say "Backups ($BACKUP_DIR)"
  ls -1sh "$BACKUP_DIR" 2>/dev/null | sed 's/^/    /' || info "none"
}

# wait_for NAME COMMAND: retry COMMAND for up to VERIFY_WAIT seconds
wait_for() {
  local name="$1" cmd="$2" t=0
  until eval "$cmd" >/dev/null 2>&1; do
    if [ "$t" -ge "$VERIFY_WAIT" ]; then printf '    FAIL  %s (after %s s)\n' "$name" "$t"; VERIFY_BAD=1; return 0; fi
    sleep 5; t=$(( t + 5 ))
  done
  printf '    ok    %s%s\n' "$name" "$([ "$t" -gt 0 ] && echo " (after $t s)")"
}
check() { if eval "$2" >/dev/null 2>&1; then printf '    ok    %s\n' "$1"; else printf '    FAIL  %s\n' "$1"; VERIFY_BAD=1; fi; }

verify_all() {
  detect_os
  VERIFY_BAD=0
  say "Endpoints (waiting up to ${VERIFY_WAIT} s for slow starts)"
  wait_for "node_exporter answers" "curl -fsS -m 5 http://127.0.0.1:9100/metrics | grep -q ^node_cpu"
  wait_for "Prometheus ready" "curl -fsS -m 5 http://127.0.0.1:9090/-/ready"
  wait_for "Loki ready" "curl -fsS -m 5 http://127.0.0.1:3100/ready"
  if svc_exists tempo && systemctl is-enabled --quiet tempo 2>/dev/null; then wait_for "Tempo ready" "curl -fsS -m 5 http://127.0.0.1:3200/ready"; fi
  wait_for "Grafana healthy" "curl -fsS -m 5 http://127.0.0.1:3000/api/health | grep -q '\"database\": *\"ok\"'"
  wait_for "every Prometheus target is up" "targets=\"\$(curl -fsS -m 10 http://127.0.0.1:9090/api/v1/targets)\" &&
    grep -q '\"health\":\"up\"' <<<\"\$targets\" && ! grep -Eq '\"health\":\"(down|unknown)\"' <<<\"\$targets\""
  check "Grafana provisioned the dashboards" "[ \$(ls /var/lib/grafana/dashboards/stack/*.json | wc -l) -ge 1 ]"
  say "Listening addresses (Grafana, Tempo's API and node_exporter stay on 127.0.0.1)"
  local l port
  for l in "Grafana:3000" "node_exporter:9100" "Tempo API:3200"; do
    port="${l##*:}"
    check "${l%:*} on 127.0.0.1:$port only" "! ss -ltnH 'sport = :$port' | awk '{print \$4}' | grep -vqx '127.0.0.1:$port'"
  done
  ss -ltnH | awk '{print "    listening " $4}' | grep -E ":($HUB_PORT_RE)\$" || true
  say "Firewall"
  local net; net="$(push_net)" || net=""
  if [ "$OPEN_FIREWALL" != 1 ]; then
    info "left alone (--no-firewall): ports $HUB_PORTS must be reachable from the pushing hosts only"
  elif [ -f /etc/iptables/rules.v4 ]; then
    check "iptables accepts ports $HUB_PORTS from ${net:-PUSH_FROM}" "[ -n '$net' ] && iptables -C INPUT -s '$net' -p tcp -m multiport --dports $HUB_PORTS -m comment --comment $PUSH_TAG -j ACCEPT"
    check "rules.v4 opens no hub port to the Internet" "! grep -Eq -- '--dport ($HUB_PORT_RE)' /etc/iptables/rules.v4"
  elif have firewall-cmd && systemctl is-active --quiet firewalld; then
    check "firewalld zone hub-push takes ${net:-PUSH_FROM}" "[ -n '$net' ] && firewall-cmd --zone=hub-push --query-source='$net'"
    check "the public zone opens no hub port" "! firewall-cmd --zone=public --list-ports | grep -Eq '($HUB_PORT_RE)/'"
  else
    info "no host firewall found: keep the Oracle Security List closed for these ports"
  fi
  [ "$VERIFY_BAD" = 0 ] && { say "All checks passed"; return 0; }
  say "Some checks failed: sudo journalctl -u SERVICE -n 50"; return 1
}

# --- Backup / restore
# confirm QUESTION
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || die "$1: add --yes to confirm (no terminal to ask)"
  printf '%s [y/N] ' "$1"; local a; read -r a; [[ $a == [yY] ]] || die "Nothing changed"
}

existing() { local p; for p in "$@"; do [ -e "$p" ] && printf '%s\n' "$p"; done; return 0; }

# backup_make KIND: KIND-config or KIND-full archive in BACKUP_DIR; the data part stops the services for a consistent copy
backup_make() {
  local kind="$1" what=config paths stamp f comp=gzip ext=gz
  [ "$CONFIG_ONLY" = 1 ] || what=full
  have zstd && { comp="zstd -T1 -3 -q"; ext=zst; }
  stamp="$(date +%Y%m%d-%H%M%S)"; f="$BACKUP_DIR/hub-$kind-$what-$stamp.tar.$ext"
  mapfile -t paths < <(existing "${CONFIG_PATHS[@]}"; [ "$what" = full ] && existing "${DATA_PATHS[@]}")
  [ ${#paths[@]} -gt 0 ] || { info "nothing to back up"; return 0; }
  say "Backup ($what) → $f"
  if dry; then dryln "archive ${paths[*]}"; return 0; fi
  install -d -m 700 "$BACKUP_DIR"
  local running=()
  if [ "$what" = full ]; then
    local s; for s in "${STOP_ORDER[@]}"; do [ "$s" != node_exporter ] && systemctl is-active --quiet "$s" 2>/dev/null && running+=("$s"); done
    [ ${#running[@]} -gt 0 ] && { info "stopping ${running[*]} for a consistent copy"; systemctl stop "${running[@]}"; }
  fi
  {
    echo "created=$(date -Is)"; echo "kind=$kind"; echo "what=$what"; echo "host=$(hostname)"
    echo "retention_days=metrics:$METRICS_RETENTION_DAYS,logs:$LOGS_RETENTION_DAYS,traces:$TRACES_RETENTION_DAYS"; echo "prometheus=$PROMETHEUS_VERSION"; echo "node_exporter=$NODE_EXPORTER_VERSION"
    if [ "$PM" = apt ]; then dpkg-query -W -f='${Package}=${Version}\n' grafana loki tempo 2>/dev/null || true; fi
  } > "$STATE_DIR/backup-meta" 2>/dev/null || true
  local rc=0 n
  # -v lists each entry as it is written: the count without reading the archive again
  n="$(tar --exclude=/var/lib/grafana/plugins-bundled -I "$comp" -cvpf "$f" "${paths[@]}" "$STATE_DIR/backup-meta" 2>/dev/null | wc -l)" || rc=$?
  [ ${#running[@]} -gt 0 ] && systemctl start "${running[@]}"
  [ "$rc" -le 1 ] || { rm -f "$f"; die "tar failed ($rc): nothing kept"; }
  chmod 600 "$f"
  info "$(du -h "$f" | cut -f1), $n entries"
  # keep the newest BACKUP_KEEP archives of this kind
  ls -1t "$BACKUP_DIR"/hub-"$kind"-"$what"-*.tar.* 2>/dev/null | tail -n +"$(( BACKUP_KEEP + 1 ))" | xargs -r rm -f
}

backup_all() {
  detect_os
  backup_make manual
  dry || say "Done. Restore with: sudo bash $0 restore FILE"
}

restore_all() {
  detect_os
  [ -n "$RESTORE_FILE" ] || { echo "Archives in $BACKUP_DIR:"; ls -1t "$BACKUP_DIR" 2>/dev/null | sed 's/^/  /'; die "Usage: $0 restore FILE"; }
  [ -f "$RESTORE_FILE" ] || RESTORE_FILE="$BACKUP_DIR/$RESTORE_FILE"
  [ -f "$RESTORE_FILE" ] || die "No such archive: $RESTORE_FILE"
  local dec=gzip; case "$RESTORE_FILE" in *.zst) dec=zstd ;; esac
  # One read checks the whole archive and takes backup-meta, its last member; an archive without one still restores
  local meta err full=0 mf; mf="$(mktemp)"
  err="$(tar -I "$dec -d" -xOf "$RESTORE_FILE" "${STATE_DIR#/}/backup-meta" 2>&1 >"$mf")" || grep -q 'Not found in archive' <<<"$err" \
    || { rm -f "$mf"; die "$RESTORE_FILE is not a readable archive"; }
  meta="$(cat "$mf")"; rm -f "$mf"
  grep -q '^what=full$' <<<"$meta" && full=1
  say "Restore $(basename "$RESTORE_FILE")"
  sed 's/^/    /' <<<"$meta"
  confirm "Replace the current config$([ "$full" = 1 ] && echo " AND all metrics, logs, traces and Grafana data") with this archive?"
  dry && { dryln "stop the services, extract, fix owners, start, verify"; return 0; }
  # a config backup of what is there now, in case the restore itself must be undone
  CONFIG_ONLY=1 backup_make pre-restore
  local s cur; for s in "${STOP_ORDER[@]}"; do systemctl stop "$s" 2>/dev/null || true; done
  if [ "$full" = 1 ]; then
    for s in "${DATA_PATHS[@]}"; do [ -d "$s" ] && find "$s" -mindepth 1 -maxdepth 1 ! -name plugins-bundled -exec rm -rf {} +; done
  fi
  tar -I "$dec -d" -xpf "$RESTORE_FILE" -C / --exclude="${STATE_DIR#/}/backup-meta"
  # owners by name: the uids may differ on a rebuilt VM
  [ -d /var/lib/prometheus ] && chown -R prometheus:prometheus /var/lib/prometheus
  [ -d /var/lib/loki ] && chown -R loki:"$SVC_GROUP" /var/lib/loki
  [ -d /var/tempo ] && chown -R tempo:"$SVC_GROUP" /var/tempo
  [ -d /var/lib/grafana ] && chown -R grafana:grafana /var/lib/grafana
  systemctl daemon-reload
  for s in "${SERVICES[@]}"; do
    if svc_exists "$s" && systemctl is-enabled --quiet "$s" 2>/dev/null; then systemctl start "$s"; fi
  done
  # the archive may hold another tunnel token or unit
  if svc_exists cloudflared && systemctl is-enabled --quiet cloudflared 2>/dev/null; then systemctl restart cloudflared; fi
  grep -E '^(grafana|loki|tempo)=' <<<"$meta" | while IFS='=' read -r p v; do
    cur="$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || true)"
    [ "$cur" = "$v" ] || warn "$p is $cur here, the archive was made with $v: install the same version if something misbehaves"
  done
  say "Restored; checking"
  verify_all
}

# --- Uninstall / clear-all
# remove_all KEEP: KEEP=1 keeps data, backups and the log (uninstall); KEEP=0 removes everything (clear-all)
remove_all() {
  local keep="$1" s
  detect_os
  if [ "$keep" = 1 ]; then confirm "Remove the monitoring hub software and config (data and backups stay)?"
  else confirm "Remove EVERYTHING: software, config, all metrics, logs, traces, Grafana data, backups in $BACKUP_DIR and the log?"; fi
  [ "$keep" = 1 ] && ! dry && [ -f "$STATE_DIR/state" ] && CONFIG_ONLY=1 backup_make pre-uninstall
  say "Stopping"
  for s in "${STOP_ORDER[@]}"; do svc_exists "$s" && run systemctl disable --now "$s" >/dev/null 2>&1 || true; done
  if state_has cloudflared || state_has cloudflared-unit || svc_exists cloudflared; then
    run systemctl disable --now cloudflared >/dev/null 2>&1 || true
    run rm -f "$CF_UNIT" "$CF_TOKEN"
    run rmdir --ignore-fail-on-non-empty /etc/cloudflared 2>/dev/null || true
  fi
  say "Packages and binaries"
  if [ "$PM" = apt ]; then
    run apt-mark unhold grafana loki tempo >/dev/null 2>&1 || true
    run env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq grafana loki tempo >/dev/null 2>&1 || true
    state_has cloudflared && { run env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq cloudflared >/dev/null 2>&1 || true; }
    run env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -qq --purge >/dev/null 2>&1 || true
    run rm -f /etc/apt/sources.list.d/grafana.list /etc/apt/keyrings/grafana.gpg
    state_has cloudflared && run rm -f /etc/apt/sources.list.d/cloudflared.list /usr/share/keyrings/cloudflare-main.gpg
  else
    run dnf versionlock delete grafana loki tempo >/dev/null 2>&1 || true
    run dnf -y -q remove grafana loki tempo || true
    state_has cloudflared && { run dnf -y -q remove cloudflared || true; run rm -f /etc/yum.repos.d/cloudflared.repo; }
    run rm -f /etc/yum.repos.d/grafana.repo
  fi
  run rm -f /usr/local/bin/prometheus /usr/local/bin/promtool /usr/local/bin/node_exporter
  run rm -f /etc/systemd/system/prometheus.service /etc/systemd/system/node_exporter.service
  for s in "${SERVICES[@]}"; do run rm -rf "/etc/systemd/system/$s.service.d"; done
  run rm -rf /etc/prometheus /etc/loki /etc/tempo /etc/grafana /usr/share/grafana /var/log/grafana /tmp/loki
  run rm -f /etc/default/grafana-server /etc/sysconfig/grafana-server
  if [ "$keep" = 0 ]; then
    run rm -rf "${DATA_PATHS[@]}" /var/lib/private/node_exporter "$BACKUP_DIR"
    for s in prometheus loki tempo grafana; do id "$s" >/dev/null 2>&1 && { run userdel "$s" || true; }; done
    for s in prometheus grafana; do getent group "$s" >/dev/null && { run groupdel "$s" || true; }; done
  else
    info "kept: ${DATA_PATHS[*]}, the service users (they own that data) and $BACKUP_DIR"
  fi
  say "OS settings"
  run rm -f /etc/systemd/journald.conf.d/90-deploy-hub.conf /etc/sysctl.d/99-zz-deploy-hub.conf
  run sysctl -q --system >/dev/null 2>&1 || true
  if state_has swapfile-hub; then run swapoff /swapfile-hub || true; run sed -i '\|^/swapfile-hub |d' /etc/fstab; run rm -f /swapfile-hub; fi
  if [ -f /etc/default/grub.d/90-deploy-hub-zswap.cfg ]; then run rm -f /etc/default/grub.d/90-deploy-hub-zswap.cfg; run update-grub >/dev/null 2>&1 || true; fi
  state_has grubby-zswap && { run grubby --update-kernel=ALL --remove-args="$ZSWAP_ARGS" || true; }
  for s in $(sed -n 's/^disabled://p' "$STATE_DIR/state" 2>/dev/null); do run systemctl enable --now "$s" >/dev/null 2>&1 || true; done
  if state_has iptables-hub-push; then run sed -i "/--comment $PUSH_TAG /d" /etc/iptables/rules.v4; drop_live_push; fi
  state_has firewalld-hub-push && { run firewall-cmd --permanent --delete-zone=hub-push >/dev/null; run firewall-cmd --reload >/dev/null; }
  run rm -rf "$STATE_DIR" /etc/deploy-hub   # the settings too (the pre-uninstall backup keeps a copy)
  run systemctl daemon-reload
  run systemctl restart systemd-journald
  [ "$keep" = 0 ] && LOG_CLEAR=1
  say "$([ "$keep" = 1 ] && echo "Uninstalled (data and backups kept)" || echo "Everything removed"). zswap stays on until the next reboot."
}

main() {
  parse_args "$@"
  [ -n "$DASHBOARDS_DIR" ] || DASHBOARDS_DIR="$SCRIPT_DIR/../../config/observe/grafana/dashboards"
  exec 3>&2   # the dry run's own lines (dryln)
  load_settings
  # One run at a time, and every run that changes something is logged
  if [ "$ACTION" != status ] && [ "$ACTION" != verify ] && ! dry; then
    [ "$(id -u)" = 0 ] || die "Run with sudo (or use dry-run)"
    exec 9>/run/lock/deploy-hub.lock
    flock -n 9 || { echo "Another deploy-hub.sh run is in progress" >&2; exit 3; }
    touch "$LOG_FILE" && chmod 600 "$LOG_FILE"
    exec > >(tee -a "$LOG_FILE") 2>&1
    printf '\n######## %s  deploy-hub.sh %s ########\n' "$(date -Is)" "$*"
  fi

  case "$ACTION" in
    install) install_all ;;
    status) status_all ;;
    verify) verify_all ;;
    backup) backup_all ;;
    restore) restore_all ;;
    uninstall) remove_all 1 ;;
    clear-all) remove_all 0 ;;
  esac
  if [ "${LOG_CLEAR:-0}" = 1 ]; then exec >&- 2>&- 3>&-; sleep 1; rm -f "$LOG_FILE"; fi
}

main "$@"
