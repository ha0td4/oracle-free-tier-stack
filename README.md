# Oracle Free-Tier Stack

A 24/7 self-hosted stack for an Oracle Always Free VM (Ampere ARM, 2 OCPU / 12 GB), on free tiers only (Oracle, Cloudflare, Tailscale).

- **No open ports.** Public traffic comes through Cloudflare Tunnel; you administer over Tailscale.
- **Locked by default.** Every subdomain sits behind Cloudflare Access, and every app has its own admin login, created for you on the first start.
- **Backed up.** Encrypted nightly backups to Oracle Object Storage plus a second provider.
- **Watched from a second VM.** The free 1 GB AMD VM, the **monitoring VM**, runs the **hub**: Prometheus, Loki and Grafana (Tempo too if
  you want traces) as system services, with dashboards for the hosts, the containers, their logs and the service checks.
- **Modular.** A tier file picks the components and their limits; your own services go in a Compose override file ([CUSTOMIZE.md](CUSTOMIZE.md)).

<!-- needs: hermes -->
It runs for **you alone** first: Hermes on Telegram, your chat page and tools. Later it can serve a **team of up to ~15** over Discord, with
one AI key per person ([TEAM.md](TEAM.md)).
<!-- /needs -->

## Start here

Before you start, read [PREPARE.md](PREPARE.md): it lists the accounts, the domain and the time you need.
Then follow its steps A → E (about 3 hours). Or build the guide site, which hides the steps your tier does not need
and tracks your progress (Node.js 24+ and pnpm on your computer):

```bash
pnpm install
pnpm build           # dist/index.html: stack map · dist/guide/: guides · dist/plan/: sizing
```

The names used everywhere: the **main VM** runs the apps; the **monitoring VM** is the second, small VM, and the **hub** is the
software on it (Prometheus, Loki, Grafana, node_exporter, cloudflared; Tempo if turned on), installed by `host/hub/deploy-hub.sh`.

## Documentation

| File | Covers | Component |
|---|---|---|
| [PREPARE.md](PREPARE.md) | **Start here.** Order of the guides, conventions, variables, A: accounts and the VM check | always |
| [CLOUDFLARE.md](CLOUDFLARE.md) | B: tunnel, Access, routes, SSL/TLS | always |
| [DEPLOY.md](DEPLOY.md) | C → E: host, stack, each app, your logins, backups, closing the ports | always |
| [IDENTITY.md](IDENTITY.md) | F: passkey login with Pocket ID | pocket-id |
| [TEAM.md](TEAM.md) | G (optional): opening the stack to other people | hermes pocket-id |
| [MEMBERS.md](MEMBERS.md) | For team members: first login, web pages, the assistant | hermes pocket-id |
| [OPERATIONS.md](OPERATIONS.md) | Commands, updates, backups, monitoring, limits, security, troubleshooting | always |
| [CUSTOMIZE.md](CUSTOMIZE.md) | Tiers, adding or removing a component, config templates | always |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, the security model, known trade-offs | always |

## Services

| Address | Service | Protection | Runs in tiers | RAM (standard) | Component |
|---|---|---|---|---|---|
| `n8n.DOMAIN` | n8n (automation) | Access `admins` (+ `members` after G), then the n8n login. Bypass `/webhook`, `/webhook-test`, `/healthz` | full, standard, lite | 1g | n8n |
| `ai.DOMAIN` | OmniRoute (AI gateway) | Access `admins` + password; `/v1` with a service token + API key | full, standard, lite | 1.5g | omniroute |
| `hermes.DOMAIN` | Hermes dashboard | Access `admins` + its own login | full, standard, lite | 3g | hermes |
| *(Discord / Telegram)* | Hermes gateway (the agent) | Discord role or ID allowlist, one session per person | full, standard, lite | - | hermes |
| `id.DOMAIN` | Pocket ID (OIDC, passkeys) | Access bypass; passkeys only | full, standard, lite | 256m | pocket-id |
| `chat.DOMAIN` | Open WebUI (chat page) | Access `admins` (+ `members`), then Pocket ID or the admin password | full, standard | 1g | open-webui |
| `monitor.DOMAIN` | Grafana: hosts, containers, logs, service checks (the hub, on the monitoring VM, with Prometheus and Loki) | Access `admins` + its login or Pocket ID | its own VM, with any tier | 280M soft / 400M hard there (systemd) | alloy |
| *(agent)* | Alloy: sends this host's metrics, container metrics and logs and the journal to the hub | not reachable from outside | full, standard, lite, agent | 256m + socket-proxy 64m | alloy |
| *(checks)* | blackbox: the service checks of this VM's apps, pushed by Alloy | not reachable from outside | full, standard, lite | 32m | blackbox |
| `dash.DOMAIN` | Homer (admin launcher) | Access `admins` | full, standard, lite | 128m | homer |
| `searxng:8080` (internal) | SearXNG (search) | not public | full, standard, lite | 512m | searxng |
| `crawl4ai:11235` (internal) | Crawl4AI (page reading) | bearer token, not public | full, standard | 1.5g | crawl4ai |
| `postgres:5432`, `valkey:6379` (internal) | Databases | internal network only | full | 512m + 192m | postgres valkey |
| *(tunnel)* | cloudflared | the only way in | full, standard, lite | 128m | always |

Each app gets its own subdomain because most break under a sub-path.

<!-- catalog -->
## Layout

```text
docker-compose.yml                  the apps (project "stack"); one profile per component
docker-compose.observe.yml          the monitoring agent (project "observe"): Alloy and socket-proxy on every host, blackbox on the app host
docker-compose.observe.attach.yml   joins the observe project to the app networks on the same host
docker-compose.override.example.yml template for your own services
.env.example                        domain, tier, admin email and secrets; ./stack.sh init makes .env from it
stack.sh                            manager: init, up, tier, upgrade, rollback, logs... (./stack.sh help)
versions.env                        pinned version of every image and restic (the hub pins its own in deploy-hub.sh)
tiers/*.env                         components and limits per tier (agent.env: an extra host that only reports to the hub)
config/                             SearXNG, Homer launcher, Hermes templates, observe/ (Alloy, blackbox, the Grafana dashboards)
host/                               setup-host.sh (Docker, swap, Tailscale, CrowdSec, security updates), install-restic.sh, tailnet-guard.sh
host/hub/                           deploy-hub.sh: the hub on the monitoring VM, no Docker
backup/                             restic backup, systemd timer, restore
tools/                              guide site builder and tests (Node.js, tools/README.md)
.github/workflows/ci.yml            ShellCheck, markdownlint, tests and the build on every push
```
<!-- /catalog -->

## Development

Install Node.js 24 and pnpm 10, then run `pnpm install`. The `stack.sh` tests need bash (Git Bash on Windows).

| Command | What it does |
|---|---|
| `pnpm run test:fast` | Every test except the `stack.sh` ones (seconds) |
| `pnpm test` | Every test, including `stack.sh` under bash (3–6 minutes) |
| `pnpm run build` | Builds the guide site into `dist/` and lints the docs first |
| `pnpm run serve` | Serves `dist/` on `http://127.0.0.1:4173` |

CI runs these linters on every push. Run them before you push, with Docker:

```bash
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x -S warning stack.sh host/*.sh host/hub/*.sh backup/*.sh
docker run --rm -v "$PWD:/workdir" davidanson/markdownlint-cli2:v0.18.1 "**/*.md"
```

## License

MIT: see [LICENSE](LICENSE).
