# Deploy

C prepares the host, D starts the stack and sets up each service, E adds backups and closes the ports.
[A](PREPARE.md) and [B](CLOUDFLARE.md) must be done first.

## C. Prepare the host

### C1. Put the code on the VM

The first copy goes over the public IP; every later update follows
[Pushing a new version](OPERATIONS.md#pushing-a-new-version-of-this-repo-to-the-vm).

1. **[Host]** pack and upload the archive: step 1 of that procedure, with `SSH_USER@PUBLIC_IP` in place of `SSH_USER@TS_NAME`
   (Tailscale comes in C3).
2. **[Remote_VM]** create the stack directory, then extract:

   ```bash
   sudo mkdir -p /opt/stack && sudo chown "$USER:$USER" /opt/stack
   tar -xzf /tmp/stack.tgz -C /opt/stack && rm /tmp/stack.tgz && sudo restorecon -R /opt/stack
   ```

   On Ubuntu leave out `&& sudo restorecon -R /opt/stack` (it resets SELinux labels, Oracle Linux only).

**Check:** `ls /opt/stack` shows `stack.sh`, `docker-compose.yml`, `versions.env`, `host/`, `backup/`.

### C2. Install Docker, swap, Tailscale, CrowdSec, restic

**[Remote_VM]**

```bash
sudo bash /opt/stack/host/setup-host.sh
```

5-15 minutes. It also turns on automatic security updates and installs `host/tailnet-guard.sh` (D8). Then **log out and back in**, so
`docker` works without `sudo`.

**Check [Remote_VM]:**

```bash
docker run --rm hello-world && docker compose version && swapon --show && sudo restic version && sudo cscli version
docker run --rm curlimages/curl -sI https://example.com | head -1
```

The last line must print `HTTP/2 200` (containers reach the Internet). If it times out, stop here: nothing later can pull images.
`sudo restic` not found: use `sudo /usr/local/bin/restic version`.

### C3. Tailscale SSH

**[Remote_VM]**

```bash
sudo tailscale up --ssh --hostname=TS_NAME
```

Open the printed link to add the VM. Then **Tailscale admin → Machines → the VM → ⋯ → Disable key expiry** (or it drops off after ~180 days).

**Check [Host]**, in a new terminal (keep the old session open):

```powershell
ssh SSH_USER@TS_NAME
```

**Do not continue until this works.** Then add this to `~/.ssh/config` on your Host, for after E3 closes port 22:

```text
Host stack-ts
    HostName TS_NAME
    User SSH_USER
```

---

## D. Start the stack, then each service

Every service step goes the same way: **log in** with the account `./stack.sh` made for you, **connect** it to the services set up before
it, **check**.
<!-- needs: pocket-id -->
Single sign-on comes later (F), next to these logins, which stay as the fallback.
<!-- /needs -->

### D1. Create the config

**[Remote_VM]**

```bash
cd /opt/stack && bash stack.sh init
nano .env
```

Set `DOMAIN=`, `CF_TUNNEL_TOKEN=` (the token from B1) and `ADMIN_EMAIL=`. Change `STACK_TIER=` only if you are not on `standard`.
<!-- needs: pocket-id -->
Also set `CF_TEAM_NAME=` (Zero Trust → **Settings → Team name and domain**): D2 then creates the Pocket ID client that F2 needs.
<!-- /needs -->
Leave every other line as it is: the secrets are generated, and the empty ones are filled in later steps.

**Your logins.** `./stack.sh up` (D2) creates every admin account with ADMIN_EMAIL; no app shows a sign-up page. Each page first asks
Cloudflare Access for your email and a code. Show all passwords at once with `grep -E '^(ADMIN_EMAIL|[A-Z_]*(_USER|_PASSWORD))=' .env`.

| Page | User | Password in `.env` | Change it | Component |
|---|---|---|---|---|
| `ai.DOMAIN` | (password only) | `OMNIROUTE_PASSWORD` | in the app | omniroute |
| `n8n.DOMAIN` | ADMIN_EMAIL | `N8N_OWNER_PASSWORD` | in `.env`, then `./stack.sh up` | n8n |
| `hermes.DOMAIN` | `HERMES_DASHBOARD_USER` | `HERMES_DASHBOARD_PASSWORD` | in `.env`, then `./stack.sh up` | hermes |
| `chat.DOMAIN` | ADMIN_EMAIL | `OPENWEBUI_ADMIN_PASSWORD` | in the app (**Settings → Account**) | open-webui |
| `monitor.DOMAIN` | `admin` | none: generated in D8 on the monitoring VM ([D9](#d9-grafana) shows where) | in the app (**Profile → Change password**) | alloy |
| `id.DOMAIN` | ADMIN_EMAIL, with a passkey (F1) | none | | pocket-id |
| `dash.DOMAIN` | (Access only) | none | | homer |

"In the app" means `.env` only seeded the first start: after that the password lives in the app.

**Check:** `grep -E '^(DOMAIN|ADMIN_EMAIL)=' .env` shows your values, and `CF_TUNNEL_TOKEN=` is not empty.

### D2. Start the stack

**[Remote_VM]**

```bash
./stack.sh up
./stack.sh ps
```

The first run pulls ~8-10 GB of images (5-15 minutes), then creates the admin accounts and prints one line for each.
<!-- needs: alloy -->
It warns that `OBSERVE_HUB` is empty: expected until the monitoring VM runs (D8).
<!-- /needs -->
<!-- needs: pocket-id -->
It also prints a one-time Pocket ID link, valid for one hour; F1 uses it and shows how to get a new one.
<!-- /needs -->

**Check:**

- Every container is `running`.
<!-- needs: hermes -->
- `hermes` may restart until D6 (`./stack.sh logs hermes` shows why).
<!-- /needs -->
- **Networking → Tunnels** shows `oracle-stack` **Healthy**.
- `.env` is saved in your password manager (it holds every login).

If B6 waited for a connected tunnel, publish the routes first.

### D3. Check the routes

**Check** in a browser:
<!-- needs: n8n -->
- `https://n8n.DOMAIN` → Access asks for your email → code → the n8n sign-in page.
- `https://n8n.DOMAIN/healthz` opens **without** a login (the Bypass path wins over `*`).
<!-- /needs -->
<!-- needs: homer -->
- `https://dash.DOMAIN` shows the admin launcher.
<!-- /needs -->
- Every other subdomain asks for your email first.
<!-- needs: pocket-id -->
- `https://id.DOMAIN` opens Pocket ID directly (bypass).
<!-- /needs -->

Errors on a route: [Troubleshooting](OPERATIONS.md#troubleshooting).

<!-- needs: omniroute -->
### D4. OmniRoute

The AI gateway: every app that calls a model goes through it, each with its own key.

1. **Log in** at `https://ai.DOMAIN` (D1).
2. Add your providers (API keys, free tiers included) and create a **combo** with a fallback order.
3. **API keys → create** a key for yourself with rate and spend limits. Each app gets its own key in its own step.

**Check [Remote_VM]:** the internal call lists your models.

```bash
docker run --rm --network stack_backend curlimages/curl -s http://omniroute:20128/v1/models -H "Authorization: Bearer <API_KEY>"
```
<!-- /needs -->

<!-- needs: n8n -->
### D5. n8n

1. **Log in** at `https://n8n.DOMAIN` with ADMIN_EMAIL and `N8N_OWNER_PASSWORD` (D1). n8n shows these as read-only: change them in `.env`
   (`N8N_OWNER_PASSWORD`, `N8N_OWNER_FIRST_NAME`, `N8N_OWNER_LAST_NAME`), then `./stack.sh up`.
2. **Connect.** Workflows call the other services by their internal names:

| Calls | Address | Key | Component |
|---|---|---|---|
| OmniRoute (models) | `http://omniroute:20128/v1` | OmniRoute → **API keys** → create `n8n`; in n8n an *OpenAI* credential with this Base URL and that key | omniroute |
| SearXNG (search) | `http://searxng:8080/search?q=…&format=json` | none | searxng |
| Crawl4AI (read a page) | `http://crawl4ai:11235/crawl` | header `Authorization: Bearer` + `CRAWL4AI_API_TOKEN` from `.env` | crawl4ai |

**Check:** `https://n8n.DOMAIN/healthz` answers `{"status":"ok"}`.

| Symptom | Cause | Component |
|---|---|---|
| n8n asks to set up an owner | `ADMIN_EMAIL` was empty, or the stack was started with plain `docker compose` (it skips the password hash): set it, `./stack.sh up` | n8n |
| The `.env` password is refused | `N8N_OWNER_PASSWORD` was edited without `./stack.sh up` afterwards | n8n |
<!-- /needs -->

<!-- needs: hermes -->
### D6. Hermes (Telegram for yourself)

**Set up** with the wizard, inside the running container:

```bash
./stack.sh hermes setup
```

| Wizard asks | Answer | Component |
|---|---|---|
| Provider | *custom*, base URL `http://omniroute:20128/v1`, key = a new OmniRoute key `hermes` with its own limits, model = your combo | omniroute |
| Messaging | Telegram: `TELEGRAM_BOT_TOKEN`, allowed users = `TELEGRAM_USER_ID` | always |
| Terminal backend | `local` (*Keep current*). Docker and the remote backends do not apply here | always |
| Browser | **Local Browser** (Chromium is in the image) | always |
| Search provider | **SearXNG** (not the preselected paid one), URL `http://searxng:8080` | searxng |

Afterwards, `./stack.sh hermes tools`: leave **Computer Use** off (there is no desktop). Keep every other toolset.

**Dashboard.** `sudo nano data/hermes/config.yaml` and add:

```yaml
dashboard:
  public_url: "https://hermes.DOMAIN"
  trusted_proxies:
    - "172.30.0.2"     # cloudflared's fixed IP
```

<!-- needs: crawl4ai -->
**Page reading (Crawl4AI, an MCP server).**

1. Register it; paste `CRAWL4AI_API_TOKEN` from `.env` when asked:

```bash
./stack.sh hermes mcp add crawl4ai --url http://crawl4ai:11235/mcp/sse --auth header
```

   The connection test **times out**: answer **`y`** to *Save config anyway?*.
2. Fix the saved entry (it needs `transport: sse`, and a failed test saved it disabled):

```bash
sudo grep -q 'transport: sse' data/hermes/config.yaml || sudo sed -i 's|^\(\s*\)url: .*crawl4ai:11235/mcp/sse.*$|&\n\1transport: sse|' data/hermes/config.yaml
sudo sed -i '/crawl4ai:/,/^  [a-z]/ s/enabled: false/enabled: true/' data/hermes/config.yaml
sudo grep -n -A8 'crawl4ai:' data/hermes/config.yaml
```

   The entry must show `transport: sse`, `enabled: true`, and the key as `${MCP_CRAWL4AI_API_KEY}`, never the token itself.
<!-- /needs -->

**Apply:**

```bash
./stack.sh restart hermes
```

**Check:**

- Message the bot on Telegram: it replies.
- `https://hermes.DOMAIN` → Access → the dashboard login (D1).
<!-- needs: searxng -->
- The wizard split the search setting in two: `config.yaml` has only `web: backend: searxng`, and the address is in `data/hermes/.env`.
  `sudo grep '^SEARXNG_URL=' data/hermes/.env` must print `SEARXNG_URL=http://searxng:8080`.
- Ask the bot about something recent: it searches. Search alone:
  `docker exec stack-searxng-1 wget -qO- 'http://localhost:8080/search?q=test&format=json' | head -c 300`.
<!-- /needs -->
<!-- needs: crawl4ai -->
- `./stack.sh hermes mcp test crawl4ai` lists `mcp_crawl4ai_*` tools, and the bot can summarize a URL.
<!-- /needs -->

| Symptom | Cause | Component |
|---|---|---|
| "Another gateway already owns this host" | A second container was started on the same data. Use `./stack.sh hermes ...` only, then `./stack.sh restart hermes` | always |
| The bot says the search backend is unavailable | `./stack.sh hermes tools` → pick SearXNG as the web backend | searxng |
| `mcp test crawl4ai` times out after 30 s | `transport: sse` is missing (step 2 above) | crawl4ai |
| `mcp test crawl4ai`: 401, or "connection failed" | Wrong token, or Crawl4AI started without one: check `CRAWL4AI_API_TOKEN`, `./stack.sh up` | crawl4ai |
| Every reply fails with "Stream ended before producing a non-ping SSE event"; OmniRoute logs `code=-32602 ... validation error` | The provider rejects `reasoning_effort: "xhigh"` (OmniRoute's own test page sends none, so it passes there). In `data/hermes/config.yaml` set `reasoning_effort: "high"`, or one model's level under `reasoning_overrides:`, then `./stack.sh restart hermes` | omniroute |
| No place to edit the OmniRoute provider in the dashboard | It lives in `custom_providers:` in `data/hermes/config.yaml` (key in `data/hermes/.env`). Change it with `./stack.sh hermes model`, or edit the file and restart | omniroute |

<!-- needs: open-webui -->
Hermes also answers as the model `hermes-agent` on port 8642; the key for it is in the D7 table.
<!-- /needs -->
<!-- /needs -->

<!-- needs: open-webui -->
### D7. Open WebUI

The chat page. `.env` only seeds its first start; from then on its **Admin Panel** holds the settings.

1. **Log in** at `https://chat.DOMAIN` with ADMIN_EMAIL and `OPENWEBUI_ADMIN_PASSWORD` (D1). Nobody else can sign up.
2. **Connect** in **Admin Panel → Settings**:

| Calls | Where | Key | Component |
|---|---|---|---|
| OmniRoute (models) | **Connections** → `http://omniroute:20128/v1` (already there) | OmniRoute → **API keys** → create `open-webui` with a spend limit (everyone on the chat page shares it) → paste, **Verify**, **Save** | omniroute |
| OmniRoute (embeddings, for documents) | **Documents** → engine *OpenAI*, URL `http://omniroute:20128/v1` | the same `open-webui` key, and an embedding model your providers offer | omniroute |
| Hermes (model `hermes-agent`) | **Connections** → `http://hermes:8642/v1` (already there) | `API_SERVER_KEY`: `sudo sed -n 's/^API_SERVER_KEY=//p' data/hermes/.env \| tr -d '"'` | hermes |
| SearXNG (web search) | **Web Search** (already set) | none | searxng |
| n8n (workflows as tools) | **Integrations** → MCP server, *Streamable HTTP* | the bearer token of an MCP Server Trigger (below) | n8n |

<!-- needs: n8n -->
**n8n workflows as tools:** in n8n, a workflow starting with an **MCP Server Trigger** (authentication *Bearer*, a long random token), with
the workflows it offers attached as *Custom n8n Workflow Tool* nodes. Activate it, copy the **Production URL**, and add it in Open WebUI
with the host replaced by `http://n8n:5678`. Every client of that trigger sees all its tools: only put there what users may run.
<!-- /needs -->

**Check:** chat with an OmniRoute model; turn on web search and ask about something recent (sources are listed); attach a small PDF and ask
about it.
<!-- needs: hermes -->
Pick `hermes-agent` and ask what it can do.
<!-- /needs -->

| Symptom | Cause | Component |
|---|---|---|
| A **Get started** sign-up form instead of a login | `ADMIN_EMAIL` was empty at the first start: create the account here with ADMIN_EMAIL (the first account becomes admin) | open-webui |
| A connection errors, or uploads fail with an embedding error | Its key in the Admin panel is empty or wrong (editing `.env` later changes nothing), or the model name does not exist in OmniRoute | open-webui |
| `hermes-agent` missing, or `Invalid gateway API key` | The key in **Connections** is not `API_SERVER_KEY` (copied with quotes?); the D6 API check must pass | hermes |
<!-- /needs -->

<!-- needs: alloy -->
### D8. Monitoring hub (second VM)

The monitoring VM from A5 gets the hub: Prometheus keeps the metrics, Loki the logs, Grafana shows them (Tempo for traces is
optional: `--tempo`), all installed as plain system services (no Docker) by `host/hub/deploy-hub.sh`, sized for 1 GB and 1/8 OCPU.
Every other host runs Grafana Alloy, which sends its data to the hub's private IP over the VCN both VMs share (Tailscale stays for
SSH); the main VM has run it since D2 and only waits for the hub's address.

Prerequisites: A5 (Ubuntu 24.04 recommended), the `oracle-observe` tunnel and its token (B1), and the archive from C1 on your Host.

1. **[Host]** upload the archive to the monitoring VM:

   ```powershell
   scp $env:TEMP\stack.tgz HUB_SSH_USER@HUB_PUBLIC_IP:/tmp/
   ```

   **[Hub_VM]** the two commands of C1 step 2 (`mkdir`, then `tar`; on Ubuntu without `restorecon`), then join Tailscale (open the
   link, then **Disable key expiry**, as in C3):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --ssh --hostname=HUB_TS_NAME
   ```

2. **[Hub_VM]** put the token of the tunnel **`oracle-observe`** (B1, not the main VM's) in a file only you can read, and preview the
   install. The first install needs all four flags:

   ```bash
   install -m 600 /dev/null ~/cf-token && nano ~/cf-token
   sudo bash /opt/stack/host/hub/deploy-hub.sh dry-run --hub-name HUB_TS_NAME --domain DOMAIN --admin-email ADMIN_EMAIL --tunnel-token-file ~/cf-token
   ```

   `--admin-email` matters: Grafana sets its admin's email only when it creates the admin, at the first start, and F3's Pocket ID
   login finds that account by its email. `install` saves the hub name, domain and email in `/etc/deploy-hub/settings.env`, so every
   later run is a bare `install`; `--tunnel-token-file` is only needed again to change the token. The defaults (retention: metrics and
   logs 90 days, traces 30; the pinned versions; the memory caps) and the other settings: [OPERATIONS.md](OPERATIONS.md#hub-settings).
3. **[Hub_VM]** install, then delete the token file (the script keeps its own copy in `/etc/cloudflared/token`, root only), then check:

   ```bash
   sudo bash /opt/stack/host/hub/deploy-hub.sh install --hub-name HUB_TS_NAME --domain DOMAIN --admin-email ADMIN_EMAIL --tunnel-token-file ~/cf-token
   rm ~/cf-token
   sudo bash /opt/stack/host/hub/deploy-hub.sh verify
   ```

   About 5-10 minutes on 1/8 OCPU. It also adds swap if the VM has little, turns on zswap, accepts the hub's four ingest ports from its own
   subnet only (`--push-from CIDR` when the hosts sit in other subnets of the VCN), and prints how to read the generated Grafana
   password (D9). Save that password in your password manager.
4. **Oracle Console:** let the pushes through the Security List. **Networking → Virtual cloud networks → your VCN → Security Lists →
   Default Security List → Add Ingress Rules**, three rules, each with **Source CIDR** = your VCN's CIDR (on the VCN's page, e.g.
   `10.0.0.0/16`), **IP Protocol** TCP and **Destination Port Range** `9090`, then `3100`, then `4317-4318`. Stateful, the default.
5. **[Remote_VM]** point the main VM at the hub and apply:

   ```bash
   sed -i 's/^OBSERVE_HUB=.*/OBSERVE_HUB=HUB_PRIVATE_IP/' .env
   sudo bash host/tailnet-guard.sh
   ./stack.sh up
   ```

   `HUB_PRIVATE_IP` is the monitoring VM's **Private IPv4 address** on its instance page, or `hostname -I | awk '{print $1}'` on it.
   `host/tailnet-guard.sh` is already in place if C2 ran with this version; running it again applies the current rules.

**Check:**

- `verify` ends with `All checks passed`, and **Networking → Tunnels** shows `oracle-observe` **Healthy**.
- **[Hub_VM]** both hosts report: the line lists your two `HOST_NAME`s, e.g. `{"status":"success","data":["observe-hub","oracle-vm"]}`.

  ```bash
  curl -s "http://127.0.0.1:9090/api/v1/label/host/values"
  ```

- **[Remote_VM]** the host reaches the hub, a container does not: the first line prints `ready`, the second fails to connect.

  ```bash
  curl -sS -m 5 "http://HUB_PRIVATE_IP:3100/ready"
  docker run --rm curlimages/curl -sS -m 5 "http://HUB_PRIVATE_IP:3100/ready"
  ```

**Rollback:** the first install can be undone completely: `sudo bash /opt/stack/host/hub/deploy-hub.sh clear-all` returns the VM to
its state before (firewall, swap, zswap and the services it turned off included). A later `install` that went wrong: `restore` its
`hub-pre-install-config-*` archive ([OPERATIONS.md](OPERATIONS.md#hub-commands)). The commands, settings and upgrades: [OPERATIONS.md](OPERATIONS.md#the-monitoring-vm).[OPERATIONS.md](OPERATIONS.md#the-monitoring-vm).

| Symptom | Cause | Component |
|---|---|---|
| A host is missing from the list | On that host, `./stack.sh logs alloy`: `no route to host` or `connection refused` = a wrong `OBSERVE_HUB` (fix it, `./stack.sh up`) or the host outside `--push-from` (`install --push-from` your VCN's CIDR); `i/o timeout` = the Security List rules of step 4 | alloy |
| `verify` fails on Grafana right after the install | Grafana needs about 2 minutes to start on 1/8 OCPU: run `verify` again, or `verify --wait 400` | alloy |
| A service restarts in a loop | `sudo journalctl -u SERVICE -n 50`; a config you edited by hand: `install` again writes the script's version | alloy |
| `install` stops on a config check | `promtool`, `loki -verify-config` or `tempo -config.verify` refused the new config: nothing was replaced, and the services keep the old one | alloy |
| The container from the last check connects | `host/tailnet-guard.sh` did not run on the main VM, or Docker uses its nftables backend: `sudo iptables -L STACK-TAILNET -n` must list the `REJECT` rule | alloy |
<!-- /needs -->

<!-- needs: alloy -->
### D9. Grafana

1. **Log in** at `https://monitor.DOMAIN`: Access first, then user `admin` and the password D8 generated. It is in Grafana's
   environment file on the monitoring VM, root only: **[Hub_VM]** `sudo grep ^GF_SECURITY_ADMIN_PASSWORD= /etc/default/grafana-server`
   on Ubuntu and Debian, `/etc/sysconfig/grafana-server` on Oracle Linux and RHEL. Grafana reads it only when it creates the admin.
2. **Dashboards → Stack** holds four dashboards, linked to each other at the top; Hosts is the home page. Pick a host, a container or a time
   range at the top of each.

| Dashboard | Shows | Component |
|---|---|---|
| Hosts | Per host: last seen, uptime, CPU, RAM, swap, disk, load, disk and network traffic; the last nightly backup | alloy |
| Containers | Per container: CPU, RAM against its limit, network, uptime, restarts, OOM kills; a row opens that container's logs | alloy |
| Logs | Every container's log and the host journal (sshd, sudo, docker...), with a search box. **Explore → Live** follows a log as it is written | alloy |
| Services | Each check below: up or down, its history as a bar, response time, uptime %, days left on the TLS certificate; the hub's own parts | blackbox |

The dashboards come from `config/observe/grafana/dashboards/`: edits made in Grafana cannot be saved over them, so save a copy, or change the
JSON in the repo. **Alerts** are not set up: when you want them, **Alerting → Contact points** (Telegram, email, a webhook...), then a rule per
thing to watch ([OPERATIONS.md](OPERATIONS.md#what-to-monitor) lists the usual ones).
<!-- needs: blackbox -->

The service checks, made from this VM by name on its Docker networks (not through the Internet, except the two `https` ones).
`./stack.sh up` writes the rows of the components your tier runs to `data/alloy/probes.yml`; Alloy picks changes up within 5 minutes.

| Check | Type | Target | Component |
|---|---|---|---|
| n8n | HTTP | `http://n8n:5678/healthz` | n8n |
| n8n via Cloudflare | HTTP | `https://n8n.DOMAIN/healthz` | n8n |
| OmniRoute | HTTP | `http://omniroute:20128` | omniroute |
| Hermes gateway | HTTP, the body must contain `"gateway_running":true` | `http://hermes:9119/api/status` | hermes |
| Open WebUI | HTTP | `http://open-webui:8080/health` | open-webui |
| SearXNG | HTTP | `http://searxng:8080/healthz` | searxng |
| Crawl4AI | HTTP (401 also counts as up) | `http://crawl4ai:11235/health` | crawl4ai |
| cloudflared | HTTP | `http://cloudflared:2000/ready` | always |
| Homer | HTTP | `http://homer:8080` | homer |
| Pocket ID | HTTP | `https://id.DOMAIN/healthz` | pocket-id |
| Postgres | TCP | `postgres:5432` | postgres |
| Valkey | TCP | `valkey:6379` | valkey |
<!-- /needs -->

**Check:** Hosts lists both hosts with values from the last minute, Logs shows lines from both, and Containers lists this VM's containers.
<!-- needs: blackbox -->
Services shows every check `UP`.
<!-- /needs -->

| Symptom | Cause | Component |
|---|---|---|
| The generated password is refused | It was changed in Grafana; the file only seeds the first start. Reset it as the `grafana` user, on Grafana's database: **[Hub_VM]** `sudo -u grafana grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini --configOverrides cfg:default.paths.data=/var/lib/grafana admin reset-admin-password <NEW_PASSWORD>` | alloy |
| A host shows "last seen" minutes ago | Its Alloy stopped sending: `./stack.sh ps` and `./stack.sh logs alloy` on that host | alloy |
| Containers is empty while Hosts works | Alloy cannot read the container stats: `/run/containerd/containerd.sock` must exist on the host, then `./stack.sh logs alloy`; as a last resort add `privileged: true` to `alloy` in `docker-compose.observe.override.yml` | alloy |
| A check is `DOWN` but the app works | The app is on a network the checks cannot reach (`backend`, `data` and `ops` only): add that network to `blackbox` in `docker-compose.observe.override.yml` | blackbox |
<!-- /needs -->

---

## E. Backup and lock the door

### E1. Fill in the backup config

**[Remote_VM]** `nano backup/backup.env`. First save `RESTIC_PASSWORD` (generated) in your password manager: **without it no backup can be read.**
Then set the primary repo (values from A2; no quotes, no spaces around `=`):

```bash
PRIMARY_REPOSITORY=s3:https://OCI_NAMESPACE.compat.objectstorage.OCI_REGION.oraclecloud.com/stack-backup/oracle-stack
PRIMARY_AWS_ACCESS_KEY_ID=OCI_ACCESS_KEY
PRIMARY_AWS_SECRET_ACCESS_KEY=OCI_SECRET_KEY
PRIMARY_AWS_DEFAULT_REGION=OCI_REGION
```

`oracle-stack` is a folder restic creates inside the bucket.

The second repo from A3 (leave the `SECONDARY_` lines as they are if you skipped it):

- **Cloudflare R2:**

  ```bash
  SECONDARY_REPOSITORY=s3:https://R2_ACCOUNT_ID.r2.cloudflarestorage.com/stack-backup/oracle-stack
  SECONDARY_AWS_ACCESS_KEY_ID=SECONDARY_ACCESS_KEY
  SECONDARY_AWS_SECRET_ACCESS_KEY=SECONDARY_SECRET_KEY
  SECONDARY_AWS_DEFAULT_REGION=auto
  ```

- **Backblaze B2:**

  ```bash
  SECONDARY_REPOSITORY=s3:https://s3.B2_REGION.backblazeb2.com/B2_BUCKET/oracle-stack
  SECONDARY_AWS_ACCESS_KEY_ID=SECONDARY_ACCESS_KEY
  SECONDARY_AWS_SECRET_ACCESS_KEY=SECONDARY_SECRET_KEY
  SECONDARY_AWS_DEFAULT_REGION=B2_REGION
  ```

**Check [Remote_VM]:** no template value is left (prints nothing), then the keys reach the buckets:

```bash
grep -nE '^[^#]*=.*(NAMESPACE|REGION|ACCOUNT_ID|BUCKET)|^PRIMARY_[A-Z_]*=$' backup/backup.env
./stack.sh snapshots
```

Before the first backup, **this error is the good result** (the bucket is reachable and still empty):

```text
Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.
```

`403`, `AccessDenied` or `SignatureDoesNotMatch` = wrong namespace, region or key. `NoSuchBucket` = wrong bucket name, or the bucket is not
in the root compartment.

### E2. Install the schedule and run the first backup

**[Remote_VM]**

```bash
sudo ./backup/install.sh
```

**Check:**

- The log ends with `Done`, and `./stack.sh snapshots` lists a snapshot on `PRIMARY` (and `SECONDARY` if set). `The first backup
  FAILED`: the timer is installed anyway; fix the cause in the log (E1), then `sudo systemctl start stack-backup.service`.
- `systemctl list-timers stack-backup.timer` shows the next run at 03:30.
<!-- needs: alloy -->
- Grafana → **Hosts** (Backup, at the bottom): the last result is `OK` and the last success a few minutes old. The Services dashboard shows
  the same.
<!-- /needs -->

`The object is in Archive tier`: the bucket was created with tier Archive, which cannot change. Create a new *Standard* bucket (A2), point
`PRIMARY_REPOSITORY` at it, run again.

### E3. Close the ports

Only after **C3 passed**. Oracle Console → **Networking → Virtual cloud networks → your VCN → Security Lists → Default Security List →
Ingress Rules** → delete the `0.0.0.0/0 TCP 22` rule and any other TCP rule from `0.0.0.0/0`. Keep the ICMP rules and the rules
whose source is your VCN's CIDR.

<!-- needs: alloy -->
The monitoring VM sits in the same subnet, so this closes its port 22 too: first check that `ssh HUB_SSH_USER@HUB_TS_NAME` works, and
add it to `~/.ssh/config` next to `stack-ts`:

```text
Host hub-ts
    HostName HUB_TS_NAME
    User HUB_SSH_USER
```
<!-- /needs -->

**Check [Host]:**

- `ssh SSH_USER@PUBLIC_IP` times out, and `ssh stack-ts` still works.
<!-- needs: alloy -->
- The same for the monitoring VM: `ssh HUB_SSH_USER@HUB_PUBLIC_IP` times out, `ssh hub-ts` works.
<!-- /needs -->
- Every subdomain still opens (the tunnel needs no inbound port).

Locked out of both? Oracle Console → Instance → **Console connection** (serial console).

Use the stack alone for a few days first. Day to day: [OPERATIONS.md](OPERATIONS.md).
<!-- needs: pocket-id -->

**Next:** [F. Identity](IDENTITY.md); [G. Team](TEAM.md) only when other people join.
<!-- /needs -->
