#!/usr/bin/env bash
# Stack manager. Run ./stack.sh help for the commands.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
SCOPE=all   # apps or observe when the command is prefixed with one

die() { echo "$*" >&2; exit 1; }
usage_error() { echo "$*" >&2; usage >&2; exit 2; }

# Bind-mounted data dirs (./data/<name>) found in the compose files, so added services need no list here
data_dirs() { grep -ohE '\./data/[A-Za-z0-9._-]+' docker-compose.yml docker-compose.override.yml docker-compose.observe*.yml 2>/dev/null | sed 's|^\./||' | sort -u; }

usage() {
  cat <<'EOF'
Usage: ./stack.sh [apps|observe] <command>

Two Compose projects: "stack" (the apps, docker-compose.yml) and "observe" (the Alloy agent and the blackbox service
checks, docker-compose.observe.yml). The monitoring hub (Prometheus, Loki, Tempo, Grafana) is not run by this script: it is
installed natively on its own VM with host/hub/deploy-hub.sh. Commands act on both projects; prefix up, stop, down, ps,
logs, restart, config, upgrade or tier with "apps" or "observe" to act on one, e.g. ./stack.sh observe restart (a prefixed
upgrade or tier does not record the versions as applied).

  init              Create .env and backup/backup.env (random secrets) and the data dirs
  up | start        Start or update the stack for the current tier
  restart [svc]     Restart (needed after editing files under data/, e.g. the Hermes config)
  stop              Stop all containers, keep data
  down              Remove containers, keep data
  ps                Container status
  logs [svc]        Follow logs
  stats             CPU and RAM per container
  upgrade [--no-backup]
                    Apply versions.env: install the pinned restic, pull, back up, recreate changed
                    containers, check health. Also: update, --upgrade
  rollback          Go back to the previously applied versions (versions.env is restored first)
  tier <name> [--hard]
                    Switch tier: standard | full | lite, your own (tiers/NAME.env) or agent (an extra host that only
                    reports to the hub). Only the containers whose config changed restart; --hard stops everything first
  snapshots         List restic backups on every repo (needs sudo)
  hermes <args>     Run the Hermes CLI inside the running container, e.g.
                      ./stack.sh hermes setup
                      ./stack.sh hermes tools
                      ./stack.sh hermes pairing list | approve discord <CODE> | revoke discord <ID>
  config            Print the resolved compose config
  help | -h         This text

Internal (backup.sh): resume brings back what stop stopped (docker compose up -d per project, nothing else).

Exit codes: 0 ok, 1 error, 2 usage (unknown command or flag).
EOF
}

# Homer has no templating: render config/dash/config.yml into data/dash/config.yml.
# {{DOMAIN}} is filled in; an item annotated "# needs: <component>" is dropped when the tier does not run it,
# and a group left without items goes with it.
render_dash() {
  mkdir -p data/dash
  awk -v on="$COMPOSE_PROFILES" '
    BEGIN { n = split(on, p, ","); for (i = 1; i <= n; i++) run[p[i]] = 1 }
    function flush_item() {
      if (item != "" && keep) { if (grp != "") { printf "%s", grp; grp = "" } printf "%s", item; printed = 1 }
      item = ""; keep = 1
    }
    /^services:/ { print; inservices = 1; keep = 1; next }
    !inservices { print; next }
    /^$/ { flush_item(); if (printed) print ""; grp = ""; printed = 0; initems = 0; next }
    /^  - name:/ { flush_item(); grp = $0 "\n"; initems = 0; next }
    /^      # needs:/ { flush_item(); pend = $3; next }
    /^      - name:/ { flush_item(); item = $0 "\n"; keep = (pend == "" || (pend in run)); pend = ""; next }
    item != "" { item = item $0 "\n"; next }
    { grp = grp $0 "\n" }
    END { flush_item() }
  ' config/dash/config.yml | sed "s|{{DOMAIN}}|${DOMAIN}|g" > data/dash/config.yml
}

# Append secrets that were added to .env.example after .env was created
add_missing_secrets() {
  local key
  while IFS= read -r key; do
    grep -q "^$key=" .env && continue
    set_env "$key" "$(openssl rand -hex 24)"
    echo "Added $key to .env (new in this version)" >&2
  done < <(sed -n 's/^\([A-Z0-9_]*\)=__GENERATE__.*$/\1/p' .env.example)
}

n8n_owner_flag() {
  N8N_OWNER_MANAGED=false
  [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${N8N_OWNER_PASSWORD_HASH:-}" ] && N8N_OWNER_MANAGED=true
  export N8N_OWNER_MANAGED
}

# n8n takes only a bcrypt hash: keep N8N_OWNER_PASSWORD_HASH matching N8N_OWNER_PASSWORD, hashed by the n8n image's bcryptjs
sync_n8n_owner_hash() {
  apps_on && profile_on n8n && [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${N8N_OWNER_PASSWORD:-}" ] || return 0
  local hash
  # By name: the password stays off the docker command line
  hash="$(PW="$N8N_OWNER_PASSWORD" HASH="${N8N_OWNER_PASSWORD_HASH:-}" docker run --rm -e PW -e HASH \
    -w /usr/local/lib/node_modules/n8n --entrypoint node "docker.n8n.io/n8nio/n8n:$VER_N8N" -e '
      const b = require("bcryptjs"), { PW, HASH } = process.env;
      let ok = false; try { ok = !!HASH && b.compareSync(PW, HASH); } catch {}
      process.stdout.write(ok ? HASH : b.hashSync(PW, 10));')"
  [[ "$hash" == '$2'* ]] || die "Could not hash N8N_OWNER_PASSWORD with the n8n image"
  if [ "$hash" != "${N8N_OWNER_PASSWORD_HASH:-}" ]; then
    set_env N8N_OWNER_PASSWORD_HASH "'$hash'"   # single quotes: the hash is full of $
    export N8N_OWNER_PASSWORD_HASH="$hash"
    echo "n8n owner password hash written to .env" >&2
  fi
  n8n_owner_flag
}

profile_on() { [[ ",$COMPOSE_PROFILES," == *,$1,* ]]; }

json_str() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }
running() { [ -n "$($1 ps --status running -q "$2" 2>/dev/null)" ]; }

# The service checks of DEPLOY.md D9, one per line: name|component|blackbox module (config/observe/blackbox.yml)|target.
PROBES='n8n|n8n|http_2xx|http://n8n:5678/healthz
n8n via Cloudflare|n8n|http_2xx|https://n8n.{{DOMAIN}}/healthz
OmniRoute|omniroute|http_2xx|http://omniroute:20128
Hermes gateway|hermes|http_gateway_running|http://hermes:9119/api/status
Open WebUI|open-webui|http_2xx|http://open-webui:8080/health
SearXNG|searxng|http_2xx|http://searxng:8080/healthz
Crawl4AI|crawl4ai|http_2xx_401|http://crawl4ai:11235/health
cloudflared|always|http_2xx|http://cloudflared:2000/ready
Homer|homer|http_2xx|http://homer:8080
Pocket ID|pocket-id|http_2xx|https://id.{{DOMAIN}}/healthz
Postgres|postgres|tcp_connect|postgres:5432
Valkey|valkey|tcp_connect|valkey:6379'

# Alloy reads its checks from data/alloy/probes.yml (file_sd format): the rows above for the components this tier runs,
# none where blackbox does not run. Rewritten on every ./stack.sh command; Alloy picks the change up within 5 minutes.
render_probes() {
  local f=data/alloy/probes.yml name comp mod target out=""
  mkdir -p data/alloy
  if profile_on blackbox; then
    while IFS='|' read -r name comp mod target; do
      [ "$comp" = always ] || profile_on "$comp" || continue
      out+="- targets: [$(json_str "${target//\{\{DOMAIN\}\}/$DOMAIN}")]"$'\n'"  labels: {probe: $(json_str "$name"), module: $mod}"$'\n'
    done <<<"$PROBES"
  fi
  [ -n "$out" ] || out=$'[]\n'
  printf '%s' "$out" > "$f.new" && mv "$f.new" "$f"
}

# Pocket ID's first admin (ADMIN_EMAIL), through the endpoint of its setup page. That works only while it has no user: a no-op
# once set up, and nobody else can claim the public id.DOMAIN first.
first_admins() {
  [ -n "${ADMIN_EMAIL:-}" ] || return 0
  if running dc pocket-id; then first_admin_pocket_id; fi
  return 0
}

# Passkeys only: the admin gets a one-time link (IDENTITY.md F1); setup_pocket_id uses the setup call's session once.
first_admin_pocket_id() {
  local _ body resp ready=""
  # It publishes no port: the host reaches it at its address on the edge network
  PID_ADDR="$(docker inspect -f '{{with index .NetworkSettings.Networks "stack_edge"}}{{.IPAddress}}{{end}}' "$(dc ps -q pocket-id)" 2>/dev/null)" || true
  [ -n "$PID_ADDR" ] || { echo "Pocket ID: no address on the edge network; run ./stack.sh up again to create its admin" >&2; return 0; }
  for _ in $(seq 30); do curl -fsS --max-time 5 -o /dev/null "http://$PID_ADDR:1411/healthz" 2>/dev/null && ready=1 && break; sleep 3; done
  [ -n "$ready" ] || { echo "Pocket ID: not answering; run ./stack.sh up again to create its admin" >&2; return 0; }
  # 2xx while nobody has signed up, an error afterwards
  curl -fsS --max-time 5 -o /dev/null "http://$PID_ADDR:1411/api/signup/setup" 2>/dev/null || return 0
  body="{\"username\":\"admin\",\"email\":$(json_str "$ADMIN_EMAIL"),\"firstName\":\"Admin\"}"
  if resp="$(pid_http POST /api/signup/setup "$body")"; then
    echo "Pocket ID: admin created (username admin, $ADMIN_EMAIL)"
    PID_TOKEN="$(sed -n 's/^Set-Cookie: [^=]*access_token=\([^;]*\).*/\1/p' <<<"$resp")"
    setup_pocket_id "$(http_body <<<"$resp" | json_get id)" ||
      echo "Pocket ID: setup stopped; add what is missing by hand (IDENTITY.md, Reference)" >&2
    PID_TOKEN=""
    echo "Pocket ID: add the admin's passkey through this link (IDENTITY.md F1):"
    dc exec -T pocket-id /app/pocket-id one-time-access-token "$ADMIN_EMAIL" 2>/dev/null | sed 's/^/  /' || true
  else
    echo "Pocket ID: could not create the admin; create it at https://id.$DOMAIN/setup" >&2
  fi
}

# pid_http METHOD PATH [BODY]: Pocket ID's API (PID_ADDR, set above). The session header and the body reach curl as a config on stdin,
# so the token stays off every command line. Prints the response with its headers; fails unless the status is 2xx.
pid_http() {
  local resp
  resp="$({ [ -z "${PID_TOKEN:-}" ] || printf 'header = %s\n' "$(json_str "Authorization: Bearer $PID_TOKEN")"
    [ -z "${3:-}" ] || printf 'data-binary = %s\n' "$(json_str "$3")"
  } | curl -sS -i --max-time 15 -X "$1" -H 'Content-Type: application/json' -K - "http://$PID_ADDR:1411$2")" || return 1
  [[ "$resp" =~ ^HTTP/[0-9.]+\ 2 ]] || { echo "Pocket ID: $1 $2: ${resp%%$'\r'*}" >&2; return 1; }
  printf '%s\n' "$resp"
}
pid_api() { pid_http "$@" | http_body; }
http_body() { awk 'b; /^\r?$/ { b = 1 }'; }

# json_get KEY: the first string value of KEY in the JSON on stdin
json_get() { awk -v k="\"$1\":\"" '{ i = index($0, k); if (i) { s = substr($0, i + length(k)); print substr(s, 1, index(s, "\"") - 1); exit } }'; }

# set_env KEY VALUE: KEY=VALUE in .env (first KEY line replaced, later ones dropped, or a line added) and in this run. The only
# writer of .env: a 0600 mktemp file next to it, the owner kept (sudo runs), renamed over it; awk adds a missing final newline.
set_env() {
  local tmp
  tmp="$(mktemp ./.env.XXXXXX)"
  if ! V="$2" awk -v k="$1" '
      index($0, k "=") == 1 { if (!done) print k "=" ENVIRON["V"]; done = 1; next }
      { print }
      END { if (!done) print k "=" ENVIRON["V"] }' .env > "$tmp"; then
    rm -f "$tmp"; die "Could not update $1 in .env"
  fi
  chown --reference=.env "$tmp" 2>/dev/null || true
  mv -f "$tmp" .env
  export "${1?}=$2"
}

# pid_client NAME CALLBACK PUBLIC GROUP_ID...: an OIDC client with NAME as its client ID, PKCE on, only GROUP_IDs allowed.
# Prints the secret Pocket ID generated (shown this once; none for a public client).
pid_client() {
  local name="$1" cb="$2" public="$3" resp secret groups
  shift 3
  groups="$(printf '"%s",' "$@")"
  resp="$(pid_api POST /api/oidc/clients "{\"id\":\"$name\",\"name\":\"$name\",\"callbackURLs\":[$(json_str "$cb")],\"isPublic\":$public,\"pkceEnabled\":true,\"isGroupRestricted\":true}")" || return 1
  pid_api PUT "/api/oidc/clients/$name/allowed-user-groups" "{\"userGroupIds\":[${groups%,}]}" >/dev/null || return 1
  [ "$public" = true ] && return 0
  secret="$(json_get secret <<<"$resp")"
  [ -n "$secret" ] || { echo "Pocket ID: no secret came back for $name" >&2; return 1; }
  printf '%s' "$secret"
}

# IDENTITY.md F1-F5 (the Reference table), with the admin's session from the setup call: groups admins and members, the admin in admins
# with a verified email, and the OIDC clients. Open WebUI and the Hermes dashboard get theirs written; Grafana and Access keep theirs in .env.
setup_pocket_id() {
  local uid="$1" admins members cfg s ow gf cf=""
  [ -n "$uid" ] && [ -n "${PID_TOKEN:-}" ] || { echo "Pocket ID: the setup call returned no session" >&2; return 1; }
  admins="$(pid_api POST /api/user-groups '{"friendlyName":"Admins","name":"admins"}' | json_get id)" && [ -n "$admins" ] || return 1
  members="$(pid_api POST /api/user-groups '{"friendlyName":"Members","name":"members"}' | json_get id)" && [ -n "$members" ] || return 1
  pid_api PUT "/api/users/$uid/user-groups" "{\"userGroupIds\":[\"$admins\"]}" >/dev/null || return 1
  # "Emails verified by default" for the people added later, and 1-day sessions (default 60 minutes: a passkey again for each app
  # after an hour). The update takes the whole configuration, as an object
  cfg="$(pid_api GET /api/application-configuration/all |
    sed -E 's/\{"key":"([^"]+)","type":"[^"]*","value":("([^"\\]|\\.)*"),"isPublic":(true|false)\}/"\1":\2/g; s/^\[/{/; s/\]$/}/
      s/"emailsVerified":"false"/"emailsVerified":"true"/; s/"sessionDuration":"[0-9]+"/"sessionDuration":"1440"/')" || return 1
  [[ "$cfg" == '{'*'"emailsVerified":"true"'*'}' && "$cfg" == *'"sessionDuration":"1440"'* && "$cfg" != *'"key":'* ]] ||
    { echo "Pocket ID: unexpected application configuration" >&2; return 1; }
  pid_api PUT /api/application-configuration "$cfg" >/dev/null || return 1
  # The admin's own email (isAdmin and the names are sent again: this update replaces them)
  pid_api PUT "/api/users/$uid" "{\"username\":\"admin\",\"email\":$(json_str "$ADMIN_EMAIL"),\"emailVerified\":true,\"firstName\":\"Admin\",\"displayName\":\"Admin\",\"isAdmin\":true}" >/dev/null || return 1
  echo "Pocket ID: groups admins and members created, admin in admins, emails verified, 1-day sessions"

  ow="$(pid_client open-webui "https://chat.$DOMAIN/oauth/oidc/callback" false "$admins" "$members")" || return 1
  set_env OPENWEBUI_OIDC_CLIENT_ID open-webui
  set_env OPENWEBUI_OIDC_CLIENT_SECRET "$ow"
  pid_client hermes-dashboard "https://hermes.$DOMAIN/auth/callback" true "$admins" || return 1
  if [ ! -f config/hermes/dashboard-oidc.env ]; then
    mkdir -p config/hermes
    printf '%s\n' "# Passkey login for the Hermes dashboard, written by ./stack.sh up (IDENTITY.md F4). Delete it to keep basic auth only." \
      "HERMES_DASHBOARD_OIDC_ISSUER=https://id.$DOMAIN" "HERMES_DASHBOARD_OIDC_CLIENT_ID=hermes-dashboard" > config/hermes/dashboard-oidc.env
  fi
  # Access takes its secret by hand in F2, days later; Grafana runs on the monitoring hub, whose .env gets it in F3
  gf="$(pid_client grafana "https://monitor.$DOMAIN/login/generic_oauth" false "$admins")" || return 1
  set_env GRAFANA_OIDC_CLIENT_SECRET "$gf"
  if [ -n "${CF_TEAM_NAME:-}" ]; then
    cf="$(pid_client cloudflare-access "https://$CF_TEAM_NAME.cloudflareaccess.com/cdn-cgi/access/callback" false "$admins" "$members")" || return 1
    set_env ACCESS_OIDC_CLIENT_SECRET "$cf"
  fi
  echo "Pocket ID: OIDC clients created; their secrets are in .env (*_OIDC_CLIENT_SECRET), the Hermes dashboard's client in config/hermes/dashboard-oidc.env"
  [ -n "$cf" ] || echo "  No CF_TEAM_NAME in .env: create the cloudflare-access client by hand (IDENTITY.md F2)"
  # Both read their client at start
  for s in open-webui hermes; do
    if profile_on "$s"; then dc up -d "$s"; fi
  done
}

need_env() { [ -f .env ] || die "No .env found. Run: ./stack.sh init"; }

# Exit unless tier $1 exists.
check_tier() {
  [ -f "tiers/$1.env" ] || die "tiers/$1.env not found"
}

load_env() {
  need_env
  add_missing_secrets
  VF="${VERSIONS_FILE:-versions.env}"          # backup.sh points it at the applied versions
  [ -f "$VF" ] || die "$VF not found"
  case "$VF" in /*) ;; *) VF="./$VF" ;; esac   # a bare name would make "." search PATH
  set -a
  # shellcheck source=versions.env
  . "$VF"
  . ./.env                                       # .env can override a pinned version
  set +a
  TIER="${STACK_TIER:-standard}"
  check_tier "$TIER"
  # Sourced last, so the tier file overrides the limits in .env
  set -a
  # shellcheck source=tiers/standard.env
  . "./tiers/$TIER.env"
  set +a
  observe_env
  n8n_owner_flag
  render_dash
  render_probes
}

observe_env() {
  if profile_on alloy && [ -z "${OBSERVE_HUB:-}" ]; then
    echo "Alloy: OBSERVE_HUB is empty in .env, so this host's metrics and logs wait until you set it to the hub's private IP (DEPLOY.md D8)" >&2
  fi
}

# STACK_APPS=0 (tiers/agent.env): this host runs the observe project only
apps_on() { [ "${STACK_APPS:-1}" != 0 ]; }

dc() { docker compose "$@"; }

# Observe project; joins the app networks when the app stack runs here.
dm() {
  local f=(-f docker-compose.observe.yml)
  apps_on && f+=(-f docker-compose.observe.attach.yml)
  [ -f docker-compose.observe.override.yml ] && f+=(-f docker-compose.observe.override.yml)
  docker compose "${f[@]}" "$@"
}

# The projects a command acts on, in start order (apps first: they create the networks observe joins). Observe is skipped when
# the tier runs none of its services (compose up fails on "no service selected"), except with "all" or "reverse" (stop order).
projects() {
  local apps="" mon=""
  [ "$SCOPE" != observe ] && apps_on && apps=dc
  if [ "$SCOPE" != apps ] && { [ -n "${1:-}" ] || [ -n "$(dm config --services 2>/dev/null)" ]; }; then mon=dm; fi
  if [ "${1:-}" = reverse ]; then echo "$mon $apps"; else echo "$apps $mon"; fi
}

# each start|reverse|all ARGS...: run "<project> ARGS" for every project in that order
each() {
  local order="$1" p
  shift
  [ "$order" = start ] && order=""
  for p in $(projects "$order"); do $p "$@"; done
}

# Start or update every project for the tier
compose_up() {
  sync_n8n_owner_hash
  each start up -d --remove-orphans
}

# The project that defines service $1
owner() { dm --profile '*' config --services 2>/dev/null | grep -qx "$1" && echo dm || echo dc; }

# Containers of services outside the active profiles are not orphans for compose: remove them
drop_inactive() {
  local s active p="$1"
  active="$($p config --services)"
  for s in $($p --profile '*' config --services); do
    grep -qx "$s" <<<"$active" && continue
    [ -n "$($p --profile '*' ps -aq "$s")" ] && $p --profile '*' rm -sf "$s"
  done
  return 0
}

# data/versions.applied = last applied versions; data/versions.prev = the ones before.
# Not after a scoped command: it left the other project on its old versions.
mark_applied() {
  [ "$SCOPE" = all ] || return 0
  mkdir -p data
  [ "$VF" -ef data/versions.applied ] && return 0   # backup.sh restarts from versions.applied itself
  if [ -f data/versions.applied ] && ! cmp -s "$VF" data/versions.applied; then cp data/versions.applied data/versions.prev; fi
  cp "$VF" data/versions.applied
}

# Fails if a service is not running at the end, or was restarting at any point in ~60 s
wait_healthy() {
  local _ out seen="" bad
  for _ in 1 2 3 4 5 6; do
    sleep 10
    out="$(each start ps -a --format '{{.Service}} {{.State}}')"
    seen+=" $(awk '$2=="restarting"{print $1}' <<<"$out")"
  done
  bad="$({ awk '$2!="running"{print $1}' <<<"$out"; tr ' ' '\n' <<<"$seen"; } | grep . | sort -u | tr '\n' ' ' || true)"
  [ -z "$bad" ] && return 0
  echo "Not healthy: $bad" >&2
  return 1
}

upgrade() {
  local backup=1 a
  for a in "$@"; do
    case "$a" in
      --no-backup) backup=0 ;;
      *) usage_error "upgrade: unknown argument: $a" ;;
    esac
  done
  load_env
  echo "Versions to apply (versions.env):"
  sed -nE '/^[A-Z0-9_]+=/{ s/[[:space:]]*#.*//; s/^/  /; p; }' "$VF"
  as_root bash ./host/install-restic.sh
  each start pull          # a bad tag stops here, nothing is touched
  if [ "$backup" = 1 ]; then
    echo "Backing up before the upgrade..."
    as_root bash ./backup/backup.sh || die "Backup failed, nothing changed. Fix it or use --no-backup."
  fi
  compose_up
  echo "Checking the containers for about 60 s..."
  if wait_healthy; then
    mark_applied
    docker image prune -f >/dev/null
    each start ps
  else
    die "Go back with: ./stack.sh rollback (if an app already migrated its data: sudo ./backup/restore.sh)"
  fi
}

# gen_file <template> <target>: copy, replacing each __GENERATE__ with a random secret
gen_file() {
  if [ -f "$2" ]; then echo "  - $2 exists, skipping"; return; fi
  (
    umask 077   # secrets: never readable by others, not even for a moment
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == *"=__GENERATE__" ]]; then
        printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 24)"
      else
        printf '%s\n' "$line"
      fi
    done < "$1" > "$2"
  )
  echo "  - created $2"
}

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

case "${1:-}" in apps|observe) SCOPE="$1"; shift ;; esac
cmd="${1:-help}"; shift || true
case "$cmd" in
  init)
    gen_file .env.example .env
    gen_file backup/backup.env.example backup/backup.env
    for d in $(data_dirs); do mkdir -p "$d"; done
    as_root chown -R 1000:1000 data/n8n          # n8n runs as uid 1000
    chmod +x stack.sh backup/*.sh host/*.sh host/hub/*.sh
    cat <<'EOF'

Next:
  1. Edit .env: set DOMAIN, CF_TUNNEL_TOKEN, CF_TEAM_NAME and ADMIN_EMAIL
  2. Edit backup/backup.env: Oracle Object Storage credentials
  3. Save .env and backup/backup.env in a password manager
  4. ./stack.sh up
EOF
    ;;
  up|start)
    load_env; echo "Tier: $TIER ($COMPOSE_PROFILES)"
    compose_up
    first_admins
    mark_applied ;;
  resume)
    # backup.sh after its snapshot: the same files and profiles as up, but no admin setup, hash sync, migration or mark_applied
    load_env
    each start up -d ;;
  restart)
    load_env
    if [ $# = 0 ]; then each start restart
    else for s in "$@"; do $(owner "$s") restart "$s"; done; fi ;;
  stop)      load_env; each reverse --profile '*' stop ;;
  down)      load_env; each reverse --profile '*' down ;;
  ps)        load_env; each all --profile '*' ps ;;
  logs)
    load_env
    if [ $# -gt 0 ]; then
      p="$(owner "$1")"; $p --profile '*' logs -f --tail=200 "$@"
    else
      for p in $(projects all); do $p --profile '*' logs -f --tail=200 & done; wait
    fi ;;
  stats)     docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' ;;
  upgrade|--upgrade|update) upgrade "$@" ;;
  rollback)
    src=data/versions.prev
    # An upgrade that failed its health check never became "applied": go back to the applied one
    if [ -f data/versions.applied ] && ! cmp -s versions.env data/versions.applied; then src=data/versions.applied; fi
    [ -f "$src" ] || die "No previous versions recorded."
    cp "$src" versions.env
    echo "versions.env restored from $src"
    upgrade --no-backup ;;
  tier)
    new="" hard=0
    for a in "$@"; do
      case "$a" in
        --hard) hard=1 ;;
        -*) usage_error "tier: unknown flag: $a" ;;
        *) [ -z "$new" ] || usage_error "tier: one tier name only"; new="$a" ;;
      esac
    done
    [ -n "$new" ] || usage_error "Missing tier name: standard | full | lite | agent | your own"
    need_env
    check_tier "$new"
    set_env STACK_TIER "$new"
    load_env
    if [ "$hard" = 1 ]; then each reverse --profile '*' down; fi
    compose_up
    first_admins
    for p in $(projects all); do drop_inactive "$p"; done
    mark_applied ;;
  hermes)
    load_env
    # A second container on the same data dir would start a second gateway and be refused: exec instead.
    if running dc hermes; then
      dc exec hermes hermes "$@"
    else
      dc run --rm hermes "$@"      # stack not running: a one-off container is safe
    fi
    case "${1:-}" in
      setup|model|tools|config|auth|login) echo "If you changed settings, apply them with: ./stack.sh restart hermes" ;;
    esac ;;
  snapshots)
    as_root bash -c '. ./backup/lib.sh
      for p in PRIMARY SECONDARY; do
        repo_enabled "$p" || continue
        echo "== $p"; restic_repo "$p" snapshots --tag stack
      done' ;;
  config)    load_env; each start config ;;
  help|-h|--help) usage ;;
  *)         usage_error "Unknown command: $cmd" ;;
esac
