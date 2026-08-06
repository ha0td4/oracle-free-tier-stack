# Operations

Running the stack day to day. Commands run on the VM in `/opt/stack` (**[Remote_VM]**, `ssh stack-ts`) unless a block says **[Host]**.

## Everyday commands

```bash
./stack.sh ps                     # container status
./stack.sh logs SERVICE_NAME      # follow one log (Ctrl+C stops)
./stack.sh stats                  # CPU and RAM per container
./stack.sh up                     # apply .env, compose or tier changes (recreates only what changed)
./stack.sh restart SERVICE_NAME
./stack.sh upgrade | rollback     # apply versions.env / go back (update is the same as upgrade)
./stack.sh tier TIER_NAME         # switch tier (--hard stops everything first)
./stack.sh observe restart        # one project only: prefix a command with apps or observe
sudo ./backup/backup.sh           # back up now
./stack.sh snapshots              # list backups
sudo cscli decisions list         # IPs blocked by CrowdSec
./stack.sh help                   # every command
```

`./stack.sh` exits with 0 when it worked, 1 on an error and 2 on a usage error (an unknown command or flag, with the usage on stderr).
A prefixed `upgrade` or `tier` (`apps` or `observe`) does not record the versions as applied: `rollback` then still goes back from the
last full `upgrade`, `tier` or `up`.

Logins and their passwords: the table in [D1](DEPLOY.md#d1-create-the-config).

### The same by hand

`./stack.sh` is a wrapper around `docker compose`. Compose alone reads neither `versions.env` nor the tier file, so plain
`docker compose ps` fails on missing variables. Define two helpers in your shell first (they last until you log out):

```bash
dc() { local t; t=$(sed -n 's/^STACK_TIER=\([^[:space:]#]*\).*/\1/p' .env); docker compose --env-file versions.env --env-file .env --env-file "tiers/${t:-standard}.env" "$@"; }
dm() { dc -f docker-compose.observe.yml -f docker-compose.observe.attach.yml "$@"; }
```

`dc` is the app project, `dm` the monitoring project (`docker-compose.observe.yml`; on a host with no apps, leave out the attach file).
Later files win, as in `./stack.sh`: the tier over `.env` over `versions.env`.

`dc` and `dm` take the arguments of `docker compose`: `dc logs -f --tail=200 SERVICE_NAME` is `./stack.sh logs`. Three need care:

- `stop` and `down`: stop the monitoring project first (`dm --profile '*' stop`), then the apps. It uses the app networks.
- `up`, `tier` and `upgrade` do more than Compose: new secrets into `.env`, the admin logins on the first start, the record that
  `rollback` uses. Use `./stack.sh` for them.
<!-- needs: hermes -->
- `hermes ARGS` is `dc exec hermes hermes ARGS`.
<!-- /needs -->

<!-- needs: n8n -->
A hand `up` also recreates n8n with its owner no longer managed from `.env`.
<!-- /needs -->

## Routine

| When | What | Component |
|---|---|---|
| Weekly | Glance at Grafana (Hosts, Services), or `./stack.sh ps` and `./stack.sh stats` | always |
| Weekly | New versions: read the release notes, edit `versions.env`, `./stack.sh upgrade` | always |
| Monthly | Oracle limits (Governance → Limits) and the Cloudflare dashboard | always |
| Monthly | Spend per key in OmniRoute | omniroute |
| Monthly | On the monitoring VM: `cloudflared` update and a pending reboot ([Security updates](#security-updates-on-the-monitoring-vm)) | alloy |
| After a hub `install` that changed a setting | Copy a config archive off the monitoring VM ([Hub backups](#hub-backups-and-recovery)) | alloy |
| Every 3 months | Test a restore on a temporary VM (below) | always |
| Someone joins or leaves | The checklist in [TEAM.md](TEAM.md#add--remove-a-person-checklist) | hermes pocket-id |

## When something breaks

- `./stack.sh ps` → which container is not `running`; `./stack.sh logs SERVICE_NAME` → why.
- `./stack.sh up` brings the stack back to its configured state.
<!-- needs: alloy -->
- Grafana (`monitor.DOMAIN`, on the monitoring VM, so it works while this VM struggles): **Services** shows what is down and since when,
  **Logs** every container's log and the journal, **Hosts** whether RAM is short or the disk full, **Containers** which one restarts.
<!-- /needs -->

Tailscale down? The Oracle Console's serial console still reaches the VM. Then see [Troubleshooting](#troubleshooting).

## Pushing a new version of this repo to the VM

The one procedure for every update of the repo, on the main VM and on the monitoring VM. The first copy, before Tailscale, is
[C1](DEPLOY.md#c1-put-the-code-on-the-vm).

1. **[Host]** pack only what the VMs need (no `.git`, no secrets) and upload it:

   ```powershell
   tar -czf $env:TEMP\stack.tgz --exclude=.git --exclude=node_modules --exclude=dist --exclude=data --exclude=.env --exclude=backup/backup.env --exclude=config/hermes/dashboard-oidc.env -C REPO_PATH .
   scp $env:TEMP\stack.tgz SSH_USER@TS_NAME:/tmp/
   ```

   On macOS or Linux use `/tmp/stack.tgz` instead of `$env:TEMP\stack.tgz`.
2. **[Remote_VM]** extract it over the old version (leave out the last line on Ubuntu: it resets SELinux labels, Oracle Linux only):

   ```bash
   cd /opt/stack && tar -xzf /tmp/stack.tgz -C /opt/stack && rm /tmp/stack.tgz
   chmod +x stack.sh backup/*.sh host/*.sh host/hub/*.sh
   sudo restorecon -R /opt/stack
   ```

   Your `.env`, `backup/backup.env` and `data/` are never in the archive, so they stay as they are.
3. **Check:** `stack.sh` has the same SHA-256 on both sides, and the compose files still resolve with your `.env` (the last command
   prints `ok`). **[Host]** `(Get-FileHash REPO_PATH\stack.sh).Hash.ToLower()` (macOS or Linux: `sha256sum REPO_PATH/stack.sh`), then
   **[Remote_VM]**:

   ```bash
   sha256sum stack.sh && ./stack.sh config >/dev/null && echo ok
   ```

4. Run what the table below says.

<!-- needs: searxng -->
SearXNG then only reads `settings.yml`, read-only, and never changes the folder's owner again.
<!-- /needs -->
<!-- needs: alloy -->

**[Hub_VM]** The monitoring VM runs the same repo. Upload the same archive to `HUB_SSH_USER@HUB_TS_NAME:/tmp/` (step 1), extract it
the same way (step 2; on Ubuntu without `restorecon`), check it with `sha256sum /opt/stack/stack.sh` alone (it has no `.env` and no
Docker), and run only the `deploy-hub.sh` row of the table there.
<!-- /needs -->

| What changed | Run | Component |
|---|---|---|
| `stack.sh`, `backup/*.sh`, `host/setup-host.sh`, `host/install-restic.sh`, docs | nothing | always |
| `host/tailnet-guard.sh` | `sudo bash host/tailnet-guard.sh` (restarts its unit with the new rules) | always |
| `docker-compose*.yml`, `tiers/*.env`, `.env`, `.env.example` | `./stack.sh up` (adds new secrets to `.env`, recreates only what changed) | always |
| A component removed from the tier | `./stack.sh tier TIER_NAME` (also removes its container) | always |
| `versions.env` | `./stack.sh upgrade` | always |
| `backup/systemd/*` | `sudo ./backup/install.sh` | always |
| `config/dash/config.yml` | `./stack.sh restart homer` | homer |
| `config/observe/config.alloy` | `./stack.sh restart alloy` (on every host) | alloy |
| `config/observe/blackbox.yml` | `./stack.sh restart blackbox` | blackbox |
| `host/hub/deploy-hub.sh`, `config/observe/grafana/dashboards/` | on the monitoring VM: `sudo bash /opt/stack/host/hub/deploy-hub.sh dry-run`, then the same with `install` | alloy |
| `config/searxng/settings.yml` | `./stack.sh restart searxng` | searxng |
| Files in `data/hermes/` | `./stack.sh restart hermes` | hermes |

## Two Compose projects

The apps are the project `stack` (`docker-compose.yml`), the monitoring the project `observe` (`docker-compose.observe.yml`). `./stack.sh`
drives both from the same `.env`, `versions.env` and tier file: apps start first (they create the networks), monitoring stops first.
<!-- needs: alloy -->
Here `observe` runs the agent: Alloy with socket-proxy, and the service checks where the tier has them. The monitoring VM runs no
Docker: the hub is a set of system services ([below](#the-monitoring-vm)).

### Extra hosts

Only when you add a machine. It runs Alloy alone and reports to the same hub.

1. New host: `sudo bash host/setup-host.sh`, `sudo tailscale up`, the repo in `/opt/stack`, `./stack.sh init`.
2. In its `.env`: `STACK_TIER=agent`, `HOST_NAME=` a name no other host uses (two hosts with one name mix their metrics and logs),
   `OBSERVE_HUB=HUB_PRIVATE_IP`. Then `./stack.sh up`. A host outside the VCN sets the hub's Tailscale IP instead: Tailscale's own
   rules on the hub accept it, a Tailscale ACL decides which devices may.

**Check:** Grafana → Hosts offers the new name within a minute. Upgrade there with `./stack.sh upgrade --no-backup`.
<!-- /needs -->

<!-- needs: alloy -->
## The monitoring VM

The hub runs here as system services: Prometheus, Loki, Grafana, node_exporter and cloudflared (and Tempo after `install --tempo`).
`host/hub/deploy-hub.sh` installs and manages all of them (D8). Run it as `sudo bash /opt/stack/host/hub/deploy-hub.sh COMMAND`:
`bash`, because the archive can lose the execute bit. `ssh hub-ts` reaches the VM after E3.

### Hub commands

| Task | Command | Component |
|---|---|---|
| Preview a change | `dry-run [FLAGS]`: every file it would write, with a diff, and every command; secrets masked. Without `sudo`, files only root can read show as "unreadable without sudo" | alloy |
| Install, or apply a change | `install [FLAGS]`: backs up the config first, checks the new Prometheus, Loki and Tempo configs (`promtool`, `loki -verify-config`, `tempo -config.verify`) before it replaces them, and restarts only what changed | alloy |
| Health | `status`: services, versions, memory, disk, retention, the settings with where each came from, the backups. `verify [--wait S]`: endpoints, targets, listening addresses, firewall | alloy |
| Back up | `backup` stops the services for about a minute for a consistent copy; `backup --config-only` takes seconds and stops nothing | alloy |
| Restore | `restore FILE [--yes]` (without `FILE` it lists the archives): backs up the current config, puts the archive back, restarts, verifies | alloy |
| Remove | `uninstall [--yes]` keeps the data and the backups; `clear-all [--yes]` removes everything, saved settings included | alloy |

Exit codes: 0 ok, 1 failed, 2 bad arguments, 3 another run holds the lock. Every run that changes something is logged to
`/var/log/deploy-hub.log`.

### Hub settings

- The defaults sit at the top of the script. `install` saves the settings you give by flag or environment variable to
  `/etc/deploy-hub/settings.env` (root only, mode 600), and every later run starts from that file: a flag wins over the environment,
  the environment over the file, the file over the default. `status` shows each setting and where it came from. Delete a line in the
  file to go back to the default.
- Saved: the hub's settings, never the secrets; `--help` lists the flags. `--zswap`, `--os-tuning`, `--firewall` and
  `--no-tempo-metrics-generator` undo a saved `--no-...`; `--no-tempo` undoes a saved `--tempo` (Tempo is off by default).
- Never saved there: secrets. The tunnel token lives in `/etc/cloudflared/token`, the Grafana admin password and the Pocket ID secret in
  Grafana's environment file (`/etc/default/grafana-server` on Ubuntu and Debian, `/etc/sysconfig/grafana-server` on Oracle Linux and
  RHEL). So `--tunnel-token-file`, `--grafana-password-file` and `--grafana-oidc-secret-file` are only for setting or changing one.
- Settings without a flag (the pinned versions, the memory caps, `SCRAPE_INTERVAL`, `LISTEN_ADDR`): change the default in your copy of
  the repo on the Host and push it ([above](#pushing-a-new-version-of-this-repo-to-the-vm)). An environment variable applies to one run
  only, and an edit to the script on the VM is lost at the next push.

### Upgrade the hub

Prerequisites: the release notes of the new version. `install` keeps a config backup by itself, but Grafana migrates its database on
start: take a full `backup` first when Grafana changes.

1. **[Host]** change the version (`GRAFANA_VERSION`, `LOKI_VERSION`, `TEMPO_VERSION`, `PROMETHEUS_VERSION`, `NODE_EXPORTER_VERSION`) at
   the top of `host/hub/deploy-hub.sh` and push the repo to the monitoring VM.
2. **[Hub_VM]** preview, apply, check:

   ```bash
   sudo bash /opt/stack/host/hub/deploy-hub.sh dry-run
   sudo bash /opt/stack/host/hub/deploy-hub.sh install
   sudo bash /opt/stack/host/hub/deploy-hub.sh verify
   ```

**Check:** `verify` ends with `All checks passed`, and `status` lists the new versions.

**Rollback:** put the old version back in the repo, push, `install` again (it downgrades the held packages). If Grafana then fails on
its migrated database, `restore` the full archive you took first.

### Security updates on the monitoring VM

`setup-host.sh` never runs on the monitoring VM, so it gets its updates from the image's own settings.

- **Ubuntu** turns on `unattended-upgrades` for security updates by default. **Check [Hub_VM]:**
  `apt-config dump APT::Periodic::Unattended-Upgrade` prints `"1"`. If not:
  `sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
- **Oracle Linux and RHEL** have no automatic updates by default. Set them up as `setup-host.sh` does on the main VM:
  `sudo dnf -y install dnf-automatic`, then in `/etc/dnf/automatic.conf` set `upgrade_type = security` and `apply_updates = yes`, then
  `sudo systemctl enable --now dnf-automatic.timer`.
- Grafana, Loki and Tempo are held (`apt-mark hold`, or `versionlock` on dnf), so only `install` moves them; Prometheus and
  node_exporter are release tarballs. cloudflared comes from Cloudflare's repository, which keeps only its newest version: update it
  once a month with `sudo apt-get update && sudo apt-get install --only-upgrade cloudflared` (or `sudo dnf -y upgrade cloudflared`).
- Kernel updates wait for a reboot: on Ubuntu, `/var/run/reboot-required` exists when one is due. After `sudo reboot` every service
  starts by itself; Grafana takes about 2 minutes.

### Hub backups and recovery

The archives live in `/var/backups/deploy-hub` on the monitoring VM itself, 5 of each kind: `install` makes a config archive before
every run (`hub-pre-install-config-*`), and `backup` makes the ones you ask for (`hub-manual-*`). Nothing runs on a schedule, and
nothing leaves the VM: if the VM is lost, so are its archives.

Copy a config archive to the main VM after every `install` that changed a setting. Its nightly backup then takes it off site, encrypted.
The archive holds the tunnel token, the Grafana admin password and the Pocket ID secret: keep it under `data/`.

1. **[Hub_VM]** make it and hand a copy to your user (`<ARCHIVE>` is the file name `backup` prints; keep it, `restore` reads the
   compression from its extension):

   ```bash
   sudo bash /opt/stack/host/hub/deploy-hub.sh backup --config-only
   sudo install -m 600 -o "$USER" /var/backups/deploy-hub/<ARCHIVE> ~/
   ```

2. **[Host]** copy it from the monitoring VM to the main VM, then delete the copy on the monitoring VM:

   ```powershell
   ssh stack-ts "mkdir -p /opt/stack/data/hub-backup"
   scp -3 hub-ts:<ARCHIVE> stack-ts:/opt/stack/data/hub-backup/
   ssh hub-ts "rm ~/<ARCHIVE>"
   ```

**Check:** `ssh stack-ts "ls -l /opt/stack/data/hub-backup"` lists the file with a recent date.

- **Recovery point:** the configuration as of the last copy. Metrics, logs and traces are never copied off the VM: a lost monitoring VM
  loses its history, which the stack accepts (the dashboards fill again from the next minute).
- **Recovery:** a new micro VM (A5) under the same Tailscale name (remove the old machine in the Tailscale admin first), its new
  private IP in `OBSERVE_HUB` on every host, the Security List rules of D8 step 4 if it sits in another VCN, the repo, then D8 steps
  1-3 with a token file of `oracle-observe` (Cloudflare shows the token again on the tunnel's page). Copy `<ARCHIVE>` back to `/tmp`
  there, `sudo bash /opt/stack/host/hub/deploy-hub.sh restore /tmp/<ARCHIVE>`,
  then `verify`. The archive brings the saved settings back too. About 30 minutes.
<!-- /needs -->

## Upgrades and rollback

Images and restic are pinned in `versions.env`, so nothing changes by surprise. `setup-host.sh` turns on automatic security updates of
the OS (unattended-upgrades or dnf-automatic) on every Docker host.
<!-- needs: alloy -->
The monitoring VM pins its own versions in `host/hub/deploy-hub.sh`: [Upgrade the hub](#upgrade-the-hub).
<!-- /needs -->

Prerequisites: the release notes of every version you change, and a working backup (the upgrade takes one first).

1. Edit `versions.env` in the repo, push it ([above](#pushing-a-new-version-of-this-repo-to-the-vm)).
2. **[Remote_VM]**:

   ```bash
   ./stack.sh upgrade
   ```

   It installs the pinned restic, pulls (a bad tag stops here, before anything changes), backs up (`--no-backup` skips it), recreates what
   changed and watches the containers for about 60 s.

**Check:** it ends by listing the containers, all `running`, and `./stack.sh ps` shows no `restarting` a few minutes later.

**Rollback:** `./stack.sh rollback` restores the versions applied before and applies them. If an app already migrated its data to the
new version, restore the backup the upgrade took instead (below).

### Pinned versions

The versions live in `versions.env` (the hub's own are at the top of `host/hub/deploy-hub.sh`). Check a release page before you change a line.

<!-- needs: postgres -->
Postgres cannot open a data directory from another major version: dump and restore, or `pg_upgrade`.
<!-- /needs -->
<!-- needs: open-webui -->
Open WebUI migrates its database on start: keep the backup `upgrade` takes.
<!-- /needs -->

## Backup and restore

Every night at 03:30 `stack-backup.timer` runs `backup/backup.sh`. It stops the apps for a few seconds if they are running (the
`observe` project keeps running, so the night's metrics and logs have no gap; the service checks show the apps down meanwhile),
copies `/opt/stack` to `/var/backups/stack-staging` without the paths in `backup/excludes.txt`, starts again exactly what it stopped
(`./stack.sh resume`: the containers only, no admin setup), then restic encrypts and uploads the copy to the primary repo and the
second one. On Sundays it also forgets old snapshots of this host only (`--tag stack --host BACKUP_HOST`: 7 daily,
4 weekly, 6 monthly) and prunes; on the 1st of the month it checks the repo.

- One backup or restore runs at a time: another one exits with status 3 (`Another backup or restore is running`).
- A repo that does not exist yet (restic's exit code 10) is created; any other error to open it fails the backup instead.
- The result goes to Grafana: Hosts → Backup and the Services dashboard (`stack_backup_last_success_timestamp_seconds`).

### Restore

`sudo ./backup/restore.sh [--yes] [PRIMARY|SECONDARY] [SNAPSHOT]`, by default `PRIMARY` and `latest`. Without a terminal (a script, a
pipe) it needs `--yes`, or it exits with status 2.

> **Warning:** restore makes `/opt/stack` match the snapshot (`rsync --delete`). Every file that is not in the snapshot is deleted,
> also a newer version of the repo and anything you added since, except the paths in `backup/excludes.txt`. It stops the stack first.

Prerequisites: on a new or rebuilt VM, C1-C3 done and your `backup/backup.env` in `/opt/stack/backup/`. On the live VM, first a fresh
backup (`sudo ./backup/backup.sh`), so you can go back to the current state.

1. **[Remote_VM]** restore, then start:

   ```bash
   sudo ./backup/restore.sh PRIMARY latest
   ./stack.sh up
   sudo ./backup/install.sh
   ```

   The snapshot is unpacked in `/var/tmp` (not `/tmp`, which is often a small RAM disk): it needs as much free disk as `data/`.
2. If you pushed a newer repo version after the snapshot was taken, push it again: the restore put the snapshot's version back.

**Check:** `./stack.sh ps` lists every container `running`, and the apps show the data of the snapshot's date.

**Rollback:** restore the backup you took before (`./stack.sh snapshots` lists it), the same way.

**Test a restore** every 3 months on a temporary VM. Do not run `./stack.sh up` there with the restored `.env`: it holds the live tunnel
and bot tokens. Inspect `data/` instead, or blank `CF_TUNNEL_TOKEN` and the tokens in `data/hermes/.env` first.

## What to monitor

| What | Where | Alert when | Component |
|---|---|---|---|
| Each service | Grafana → Services | 2 failed checks in a row | blackbox |
| The path through Cloudflare | Services: `n8n via Cloudflare` | 2 failed checks in a row | blackbox n8n |
| Tunnel | Services: `cloudflared`, and the B8 alert | connection lost | blackbox |
| Nightly backup | Hosts → Backup (`stack_backup_last_success_timestamp_seconds`) | older than 26 h, or the last result `FAILED` | alloy |
| A host stops reporting | Hosts → Last seen | more than 5 min | alloy |
| Host CPU, RAM, disk | Grafana → Hosts | CPU > 85% for 10 min, RAM > 85%, disk > 80% | alloy |
| A container near its RAM cap | Grafana → Containers (RAM % of limit), or `./stack.sh stats` | > 90% of its cap: raise it or change tier | always |
| Container logs | Grafana → Logs | when a service misbehaves | alloy |
| AI spend per key | OmniRoute · `ai.` | a key near its limit | omniroute |
| Hermes sessions | `./stack.sh hermes pairing list` | often at `max_concurrent_sessions` | hermes |
| Hermes dashboard logins | `data/hermes/logs/dashboard-auth.log` | a login you did not make | hermes |

<!-- needs: alloy -->
No alert is sent by default: add a contact point and rules in Grafana (**Alerting**) for the rows you care about (D9). Start with
a watchdog: a rule that always fires, sent to an outside dead man's switch (a free heartbeat service). Grafana runs on the monitoring VM,
so when that VM dies no other alert can tell you.
<!-- /needs -->

## Limits to watch

Providers change these: compare with the official pages.

| Limit | This stack | Component |
|---|---|---|
| Oracle A1: 2 OCPU / 12 GB | 2 OCPU / 12 GB | always |
| Oracle E2.1.Micro: two VMs, 1 GB each | one is the monitoring VM (A5) | alloy |
| Oracle reclaims idle VMs: CPU, network and RAM under ~20% for 7 days | RAM normally above 20%; Pay As You Go (free within limits) removes the risk | always |
| Oracle block storage: 200 GB | the boot volumes: 100 GB here (~30 GB used), 50 GB per small VM | always |
| Oracle Object Storage: ~20 GB, 50,000 requests/month | a few GB; daily backup, weekly prune | always |
| Cloudflare Access: 50 users | you, plus members after G | always |
| Cloudflare WAF: 5 custom rules, 1 rate-limit rule | 1 + 1 | always |
| R2 or B2: 10 GB | second backup repo | always |
| Discord: 100 slash commands per bot | Hermes logs a warning when some are dropped | hermes |
| Free AI provider quotas | shared by everyone; usually the first limit a team hits | omniroute |

## When free tiers shrink: fallbacks

| Risk | Plan | Component |
|---|---|---|
| Oracle cuts the A1 quota | `./stack.sh tier lite`, or a smaller tier built on the Plan page | always |
| Lost account or VM | Any ARM64 or x86 VPS: `setup-host.sh`, then restore from `SECONDARY` | always |
| Cloudflare Tunnel or Access become paid | Admins move to Tailscale; webhooks use Tailscale Funnel, or open 443 with Caddy | always |
| Access becomes paid, Pocket ID stays | Caddy + a forward-auth proxy (tinyauth, oauth2-proxy) logging in through Pocket ID | pocket-id |
| Pocket ID down | Access falls back to One-time PIN, the apps to their own logins (D1) | pocket-id |
| Discord changes its bot policy | Hermes supports Telegram, Matrix, Slack and more; use ID allowlists and pairing | hermes |
| Tailscale changes its free plan | Headscale or plain WireGuard | always |
| AI providers cut free tiers | Change the fallback chain in OmniRoute; nothing else points elsewhere | omniroute |
| SearXNG gets blocked | Enable other engines in `config/searxng/settings.yml`, or a free search API | searxng |

## Security

- **Secrets** live in `.env`, `backup/backup.env` and `data/` only (git ignores them). Keep `.env` and `RESTIC_PASSWORD` in a password manager.
- **Containers** run with `no-new-privileges`, a process limit, rotated logs and only the capabilities their image needs; several have
  a read-only root.
<!-- needs: socket-proxy -->
- **Docker API** only through the read-only `socket-proxy` (`POST=0`). Keep the host's users to the admins: the accepted risk
  is in [SECURITY.md](SECURITY.md).
<!-- /needs -->
<!-- needs: alloy -->
- **containerd's socket** goes into Alloy: see [SECURITY.md](SECURITY.md).
<!-- /needs -->
<!-- needs: alloy -->
- **Monitoring hub:** Prometheus (9090), Loki (3100) and Tempo's OTLP ports (4317, 4318) have no login. `verify` checks the `--push-from`
  rule and that no hub port is open to the Internet; the Security List admits the VCN only. Logs can hold secrets an app prints:
  treat the monitoring VM like the main VM.
<!-- /needs -->
<!-- needs: hermes -->
- **Hermes** has every toolset and one shared memory: [SECURITY.md](SECURITY.md) has the trade-off. Never set `*_ALLOW_ALL_USERS`.
  Its API (port 8642) has no route and needs `API_SERVER_KEY`.
<!-- /needs -->
<!-- needs: pocket-id -->
- **Pocket ID** is the only public page besides the webhook and health paths: passkeys only, no open sign-up, rate-limited at Cloudflare.
  `./stack.sh up` claims its admin account at the first start, so nobody else can.
- **Sessions last a day** (Pocket ID and Access, IDENTITY.md F1/F2): a lost or stolen device stays signed in until then. To end one at
  once: [Revoke a session](#revoke-a-session).
<!-- /needs -->
<!-- needs: crawl4ai -->
- **Crawl4AI** needs its bearer token and sits on the `backend` network only.
<!-- /needs -->
<!-- needs: omniroute -->
- **AI cost:** a spend limit on every OmniRoute key, in case an agent loops.
<!-- /needs -->

More, with the known trade-offs and how to report a vulnerability: [SECURITY.md](SECURITY.md).

<!-- needs: pocket-id -->
### Revoke a session

For a lost or stolen device, or a person who leaves:

1. Pocket ID → **Administration → Users** → the user → **Account Disabled** (for one lost device of your own, delete its passkey
   instead).
2. Zero Trust → **My Team → Users** → the user → **Revoke session**.

**Check:** a private window on that account gets the Access login again, and Pocket ID refuses the account.
<!-- needs: open-webui -->
An Open WebUI session survives both: delete the user there too (Admin Panel → Users).
<!-- /needs -->
<!-- /needs -->

## Troubleshooting

Errors of a single step are listed under that step (D3 for routes, E1 and E2 for backups).
<!-- needs: pocket-id -->
Logins through Pocket ID: the tables in [IDENTITY.md](IDENTITY.md#reference) (F2 onwards).
<!-- /needs -->

| Symptom | Cause and fix | Component |
|---|---|---|
| `./stack.sh: Permission denied` | Execute bit lost on Windows: `chmod +x stack.sh backup/*.sh host/*.sh host/hub/*.sh` | always |
| `bad interpreter: /bin/bash^M` | CRLF line ends: `sed -i 's/\r$//' stack.sh backup/*.sh host/*.sh host/hub/*.sh` | always |
| `Unknown command` and the usage (exit status 2) | A typo, or a command of another version: `./stack.sh help` | always |
| A container fails with `EACCES` | `sudo chown -R 1000:1000 data/SERVICE_DIR`; on Oracle Linux also `sudo restorecon -R /opt/stack` | always |
| `dnf` conflict with `runc` or `podman-docker` | `sudo dnf remove podman-docker runc`, run `setup-host.sh` again | always |
| `setup-host.sh`: `/swapfile is in use: not touching it` | It never resizes an active swap file. To grow it: `sudo swapoff /swapfile && sudo rm /swapfile`, then run `setup-host.sh` again | always |
| `Another backup or restore is running` (exit status 3) | The nightly backup holds the lock: `systemctl status stack-backup.service`, try again when it ends | always |
| Cloudflare 502 | Wrong Service URL in the route, or the container is down | always |
| Error 1033, tunnel *Inactive* | `./stack.sh logs cloudflared`; `CF_TUNNEL_TOKEN` must be the whole token | always |
| `network stack_edge not found` | The app project is not up: run `./stack.sh up` (it starts the apps first) | always |
| An admin page shows a setup or sign-up page | `ADMIN_EMAIL` was empty when the app first started: set it, `./stack.sh up` | always |
| Backup fails with 403 | Wrong key, namespace or region in `backup/backup.env` | always |
| SearXNG returns nothing | Engines blocked from datacenter IPs: enable others | searxng |
| `setup-host.sh` stops on the page size | 64K kernel: see [A1](PREPARE.md#a1-check-the-existing-vm) | always |
| Valkey: `Unsupported system page size` | 64K kernel: skip the `full` tier or switch kernels | valkey |
| A webhook redirects to a login | The `n8n-webhook` Bypass application is missing (B5) | n8n |
| Webhook callers get a challenge page or 403 | Bot Fight Mode is on: [turn it off](CLOUDFLARE.md#optional-security-hardening-free-waf) | n8n |
| `Alloy: OBSERVE_HUB is empty` on every command | Set `OBSERVE_HUB` in `.env` to the hub ([D8](DEPLOY.md#d8-monitoring-hub-second-vm)), `./stack.sh up` | alloy |
| A host or a dashboard in Grafana is empty | The symptom tables of [D8](DEPLOY.md#d8-monitoring-hub-second-vm) and [D9](DEPLOY.md#d9-grafana) | alloy |
| `required variable HERMES_DASHBOARD_PASSWORD is missing a value`, or the dashboard logs "Refusing to bind ... no auth providers" | `HERMES_DASHBOARD_PASSWORD` or `_SECRET` empty or too short in `.env`: set a long value, `./stack.sh up` | hermes |
| Hermes dashboard login fails | `public_url` and `trusted_proxies` in `config.yaml` (D6); with OIDC, a public client and group `admins` (F4) | hermes |
| A member gets no reply on Discord | No allowed role, the channel is ignored, or no @mention outside `#hermes` | hermes |
| OIDC logins fail at once | `id.DOMAIN` lost its bypass in Access, or `APP_URL`/`TRUST_PROXY` is wrong | pocket-id |
| `dash.DOMAIN` links are wrong | Edit `config/dash/config.yml` (never `data/dash/`), `./stack.sh restart homer` | homer |
