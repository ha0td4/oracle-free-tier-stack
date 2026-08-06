# Customize

Fit the stack to your machine: pick a tier, add or remove a component, edit a config template. Each change is a file edit plus one command.

<!-- catalog -->

## Tiers

A **tier** is a file in `tiers/`: `COMPOSE_PROFILES` (the components that run) plus the RAM/CPU limits of the heavy ones. `STACK_TIER` in `.env`
picks it. Not sure which? The Plan page of the guide site (`/plan/`) takes your RAM and CPU, recommends one and can write a custom tier file.

| Tier | When | Runs | Limits total |
|---|---|---|---|
| `full` | the same machine and you need your own databases | everything in `standard` + Postgres and Valkey (a little over the 85% rule) | 10,272 MiB |
| `standard` | 2 OCPU / 12 GB, you alone or a team of up to ~15 (the default) | n8n, OmniRoute, Hermes (3g), SearXNG, Pocket ID, Open WebUI, Crawl4AI (1.5g), Alloy and the service checks (the monitoring agent), Homer | 9,568 MiB |
| `lite` | about 1 OCPU / 6 GB (reduced Oracle quota or a small VPS) | no Crawl4AI (use Jina Reader) and no Open WebUI, keeps Pocket ID | 4,704 MiB |

<!-- generated: tier-table -->

- A limit is a ceiling: a container that hits it is restarted. Keep the **total below ~85% of usable RAM**; the rest is for the OS and page cache.
- Only Hermes and Crawl4AI (they run a browser) have CPU caps and lower CPU weights, so n8n, OmniRoute and the tunnel stay responsive.
- Smaller than `lite` (e.g. the free 1 GB AMD Micro VM): no ready-made app tier fits. Build one on the Plan page; cloudflared plus n8n at `MEM_N8N=448m`
  (n8n idled at about 285 MiB in a test) is the usual start, with swap and a lean host setup.
- The monitoring hub is not a tier: `host/hub/deploy-hub.sh` installs it without Docker on the monitoring VM (DEPLOY.md D8), and
  `./stack.sh tier observe` stops with a pointer to that script. `tiers/agent.env` is an extra host that only reports to the hub
  ([OPERATIONS.md](OPERATIONS.md#extra-hosts)).

Switch tier (only changed containers restart; `--hard` stops everything first):

```bash
./stack.sh tier lite
./stack.sh stats
```

**Check:** `./stack.sh ps` lists only the tier's containers, all `running`. **Rollback:** `./stack.sh tier` with the tier you had; a
component the switch removed kept its data under `data/` and comes back as it was.

### Make your own tier

Copy the closest file, edit it, switch to it:

```bash
cp tiers/standard.env tiers/mine.env
nano tiers/mine.env        # COMPOSE_PROFILES=... and MEM_*, CPU_*, *_HEAP_MB values (keep a heap below its MEM_ limit)
./stack.sh tier mine
```

Every service's limit reads `${MEM_NAME:-default}`, `MEM_HOMER`, `MEM_VALKEY`, `MEM_SOCKET_PROXY` and `MEM_BLACKBOX` included: a variable
in the tier file wins, otherwise the default in the compose file applies. The defaults match the `standard` tier.

### Reference measurements

On an A1.Flex with 2 OCPU and 12 GB, Oracle Linux 10 and the image's 4 GiB swap, the OS uses about 655 MiB after boot, so expect about
1 GB used once Docker, CrowdSec and Tailscale run. Two cores, 1 thread each; sequential disk reads about 85 MB/s on one thread.

Disk budget (boot volume), about 30 GB in total, so the default size is usually enough:

| Item | Estimate | Notes |
|---|---|---|
| Oracle Linux and system packages | ~7 GB | 11 GB used on a fresh image, minus the 4 GB swap |
| Docker images | ~8-10 GB | Crawl4AI and Hermes are largest because they bundle a browser |
| Data in `data/` | hundreds of MB to a few GB | Grows with n8n runs and Hermes memory |
| Backup staging copy | same as `data/` | `/var/backups/stack-staging` |
| Container logs | ≤ 30 MB per container | Rotated: 3 files × 10 MB |

## Components

`cloudflared` always runs: it is the tunnel, the only way in (needs `CF_TUNNEL_TOKEN`). Everything else is a component you switch on in a
tier file.

| Name | Services | Needs | Notes |
|---|---|---|---|
| `n8n` | `n8n` | | The automation engine: workflows and webhooks |
| `omniroute` | `omniroute` | | One AI gateway for n8n, Hermes and your own tools |
| `hermes` | `hermes` | `omniroute` for models, 4K pages (browser tool) | The agent: Discord and Telegram |
| `searxng` | `searxng` | | Private search; Hermes and n8n call it |
| `crawl4ai` | `crawl4ai` | `CRAWL4AI_API_TOKEN`, 4K pages | Reads web pages; 1.5g in standard and full |
| `pocket-id` | `pocket-id` | | OIDC and passkeys for Access, the Hermes dashboard, Grafana and Open WebUI |
| `open-webui` | `open-webui` | `omniroute` for models, `pocket-id` for the login | Chat page at `chat.DOMAIN` (yours, and members' after G); Hermes as a model, n8n workflows as tools |
| `alloy` | `alloy`, `socket-proxy` | | The monitoring agent, on every host: host and container metrics, container logs and the journal, pushed to the hub (`OBSERVE_HUB`) |
| `blackbox` | `blackbox` | `alloy` | The service checks (HTTP, keyword, TCP) of DEPLOY.md D9, run through Alloy |
| `homer` | `homer` | | Admin launcher at `dash.DOMAIN` |
| `postgres` | `postgres` | | Unused by default; internal `data` network |
| `valkey` | `valkey` | 4K pages | Unused by default; internal `data` network |

## Add or remove a component

Your own services go in `docker-compose.override.yml`, a file Compose merges automatically and git ignores, so repo updates never conflict.

### Add one

1. `cp docker-compose.override.example.yml docker-compose.override.yml` and define the service: `profiles: [NAME]` (same as the service
   name), a **pinned** image, `mem_limit: ${MEM_NAME:-64m}`, and a network (`edge` = reachable by cloudflared, `backend` = outbound only,
   `ops` = admin tools, `data` = internal). Keep the example's hardening lines, and add `cap_drop: [ALL]` and `read_only: true` where the
   image allows them.
2. Add `NAME` to `COMPOSE_PROFILES` in your tier file (and `MEM_NAME=` if the limit differs per tier).
3. Secrets: add `NAME_SECRET=__GENERATE__` to `.env.example`; the next `./stack.sh` command adds it to `.env` with a random value.
4. `./stack.sh up`. Its data under `./data/NAME` is backed up every night.
5. A route in [B6](CLOUDFLARE.md#b6-publish-the-routes) (already admins-only through `stack-admin`), a launcher link in `config/dash/config.yml`,
   a service check (a line in `PROBES` in `stack.sh`, and its network for `blackbox` if it is not on `backend`, `data` or `ops`).
6. Docs: wrap its steps in `<!-- needs: NAME -->` ... `<!-- /needs -->` and give table rows a `Component` column; `npm run test:fast`
   checks both (see [Development](README.md#development)).

### Remove one

1. Delete its name from `COMPOSE_PROFILES` in your tier file.
2. `./stack.sh tier TIER_NAME` removes the container; its data stays under `data/`.
3. Optional cleanup: the Cloudflare route and DNS record, the Homer link, the `data/NAME` folder and its secrets (its service check goes by itself).

<!-- /catalog -->

## Internal addresses

How the pieces call each other, all on the Docker networks (nothing here is public):

| From | Calls | Example | Component |
|---|---|---|---|
| n8n (HTTP Request) | SearXNG | `GET http://searxng:8080/search?q=...&format=json` | n8n searxng |
| n8n | Crawl4AI | `POST http://crawl4ai:11235/crawl`, header `Authorization: Bearer <CRAWL4AI_API_TOKEN>`, body `{"urls": ["https://..."]}` | n8n crawl4ai |
| any container | LLM | `http://omniroute:20128/v1` (OpenAI-compatible) + API key | omniroute |
| Hermes | Crawl4AI | MCP server `crawl4ai` (`http://crawl4ai:11235/mcp/sse`, `transport: sse`, token via `${MCP_CRAWL4AI_API_KEY}`) | hermes crawl4ai |
| Hermes | SearXNG | built-in web search: `SEARXNG_URL` in `data/hermes/.env` + `web.backend: searxng` | hermes searxng |
| Open WebUI | Hermes | OpenAI connection `http://hermes:8642/v1`, key `API_SERVER_KEY` from `data/hermes/.env`, model `hermes-agent` | open-webui hermes |
| Open WebUI | n8n | MCP server (Streamable HTTP) `http://n8n:5678/mcp/<MCP_PATH>` (the trigger's production path), bearer token from the MCP Server Trigger | open-webui n8n |
| Open WebUI | SearXNG | web search: `http://searxng:8080/search` (`SEARXNG_QUERY_URL` in compose) | open-webui searxng |
| any container on the `data` network | Postgres | `postgres://app:<POSTGRES_PASSWORD>@postgres:5432/app` (user/db from `.env`) | postgres |
| any container on the `data` network | Valkey | `redis://:<VALKEY_PASSWORD>@valkey:6379` (password only, no username) | valkey |

<!-- needs: postgres valkey -->
Postgres and Valkey (`full` tier) are used by nothing by default: the apps store in SQLite. They publish no host port; test from inside, e.g.
`docker exec stack-valkey-1 valkey-cli --no-auth-warning -a "$(grep ^VALKEY_PASSWORD= .env | cut -d= -f2)" ping`.
<!-- /needs -->

Other free options:

- **Page reading:** Jina Reader `https://r.jina.ai/URL` (rate-limited free tier) is a free alternative when your tier has no page-reading
  component. It sends the page's URL to a third party, so do not use it for private pages.

<!-- needs: searxng -->
- **Search:** some search APIs have a monthly free quota (Tavily, Exa...). Use one as a fallback when the private search is blocked. Quotas
  change often, so re-check them.
<!-- /needs -->

## Config templates

Every file you may edit. The first column is the file in this repository; **Goes to** is where it lives on the VM (relative to `/opt/stack`).
The guide shows each one with its real contents.

| File | Purpose | Goes to | Apply with | Component |
|---|---|---|---|---|
| `.env.example` | Domain, tier, admin email, generated secrets and admin passwords | `.env` (made by `./stack.sh init`) | `./stack.sh up` | always |
| `versions.env` | Pinned version of every image and restic | `versions.env` | `./stack.sh upgrade` | always |
| `tiers/full.env` | Components and limits, full tier | `tiers/full.env` | `./stack.sh tier full` | always |
| `tiers/standard.env` | Components and limits, standard tier | `tiers/standard.env` | `./stack.sh tier standard` | always |
| `tiers/lite.env` | Components and limits, lite tier | `tiers/lite.env` | `./stack.sh tier lite` | always |
| `tiers/agent.env` | Extra host that only runs the monitoring agent | `tiers/agent.env` on that host | `./stack.sh tier agent` | always |
| `docker-compose.override.example.yml` | Add your own services or change limits (for the monitoring project use `docker-compose.observe.override.yml`, same format; git ignores both) | `docker-compose.override.yml` | `./stack.sh up` | always |
| `backup/excludes.txt` | What the nightly backup skips (caches, logs, sockets) | `backup/excludes.txt` | the next backup | always |
| `backup/backup.env.example` | Backup repositories and keys, restic password | `backup/backup.env` (made by `./stack.sh init`) | `sudo ./backup/install.sh`, then the next backup | always |
| `config/dash/config.yml` | Admin launcher links (Homer) | `config/dash/config.yml` | `./stack.sh restart homer` | homer |
| `config/observe/config.alloy` | What Alloy reads on each host and sends to the hub (labels the dashboards rely on) | `config/observe/config.alloy` | `./stack.sh restart alloy` | alloy |
| `config/observe/blackbox.yml` | How each service check is made (HTTP, keyword, TCP) | `config/observe/blackbox.yml` | `./stack.sh restart blackbox` | blackbox |
| `host/hub/deploy-hub.sh` | The monitoring hub: defaults at the top (retention, versions, memory caps); the flags you pass are saved in `/etc/deploy-hub/settings.env`; commands in [OPERATIONS.md](OPERATIONS.md#the-monitoring-vm) | `host/hub/deploy-hub.sh` on the monitoring VM | `sudo bash /opt/stack/host/hub/deploy-hub.sh install` | alloy |
| `config/searxng/settings.yml` | Search engines, JSON output | `config/searxng/settings.yml` | `./stack.sh restart searxng` | searxng |
| `config/hermes/env.team.example` | Discord token, allowed roles, home channel | append to `data/hermes/.env` | `./stack.sh restart hermes` | hermes |
| `config/hermes/config.team.example.yaml` | Team settings: sessions, Discord channels, command limits | merge into `data/hermes/config.yaml` | `./stack.sh restart hermes` | hermes |
| `config/hermes/AGENTS.example.md` | Short shared context for every session | `data/hermes/AGENTS.md` | `./stack.sh restart hermes` | hermes |
| `config/hermes/dashboard-oidc.env.example` | Passkey login for the Hermes dashboard (Pocket ID) | `config/hermes/dashboard-oidc.env` | `./stack.sh up` | hermes pocket-id |
