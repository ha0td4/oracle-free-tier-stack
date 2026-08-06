# Security

## Reporting a vulnerability

Report it privately to the maintainer, never in a public issue: on GitHub, **Security → Report a vulnerability** (private
vulnerability reporting). Include what is affected (a script, a compose service, a doc step), how to reproduce it, and what an
attacker gains.

Only the `main` branch is maintained. A flaw in an upstream image or package (n8n, Grafana, Docker...) goes to that project; report it
here too if this repo's configuration makes it worse.

## Security model

| Boundary | What protects it |
|---|---|
| Internet → apps | No open port. Cloudflare Tunnel is the only way in; Cloudflare Access locks every subdomain to `admins` (`members` for the team pages), and every app keeps its own login behind it |
| Internet → hosts | Oracle Security Lists without SSH after E3; administration over Tailscale SSH only; CrowdSec on the main VM |
| Containers → host and each other | Docker networks per role (`edge`, `backend`, `ops`, `data`); `no-new-privileges`, process limits, dropped capabilities and read-only roots; the Docker API only through a read-only proxy |
| Containers → monitoring hub | `host/tailnet-guard.sh` rejects container connections to the hub's ingest ports 9090, 3100, 4317 and 4318 on any private or tailnet address |
| Monitoring VM | Prometheus, Loki and Tempo accept connections from the VCN subnet only (host firewall and Security List), and over the tailnet through Tailscale's own rules; Grafana listens on `127.0.0.1` and is published through its own tunnel, behind Access |
| Secrets | `.env`, `backup/backup.env` (mode 600) and `data/` on the VMs, never in git; restic encrypts every backup; the hub keeps its secrets in root-only files |

The operating rules (ports, sessions, secrets, per-component notes) are in [OPERATIONS.md](OPERATIONS.md#security).

## Patching

- Every Docker host: `host/setup-host.sh` turns on automatic security updates of the OS (unattended-upgrades on Ubuntu and Debian,
  dnf-automatic with `upgrade_type = security` on Oracle Linux and RHEL).
- The monitoring VM: `setup-host.sh` never runs there; [OPERATIONS.md](OPERATIONS.md#security-updates-on-the-monitoring-vm) sets it up.
- Images, restic and the hub's services are pinned (`versions.env`, the top of `host/hub/deploy-hub.sh`): they change only when you
  change a version, after reading its release notes. restic downloads are checked against the release's `SHA256SUMS`; Prometheus and
  node_exporter tarballs against their published checksums.

## Known trade-offs

Each one is accepted on purpose; the reason is next to it.

- **Vendor install scripts piped to a shell.** `setup-host.sh` runs `curl ... | sh` for Docker on apt systems (`get.docker.com`),
  Tailscale (`tailscale.com/install.sh`) and CrowdSec (`install.crowdsec.net`), and `D8` does the same for Tailscale on the monitoring
  VM. Each script adds the vendor's signed package repository, which the package manager then verifies; the script itself is trusted as
  served over TLS. To avoid it, install those packages from the vendors' repositories by hand first: `setup-host.sh` skips what is
  already installed.
- **socket-proxy exposes container environments.** Alloy needs `GET /containers/{id}/json`, which includes each container's
  environment, so the secrets from `.env` are readable by any local process that opens `127.0.0.1:2375`, users outside the `docker`
  group included. Keep the host's user accounts to the admins.
- **Alloy is root-equivalent on each host.** It mounts containerd's socket, which has no read-only mode, so cAdvisor sees containers
  under Docker 29's image store. Nothing reaches Alloy from outside the host.
- **Hermes has every toolset**, terminal included, and one long-term memory shared by everyone it serves. It is contained in its own
  container, off the admin network, with caps, a quota'd key and user allowlists; members are told not to give it secrets.
- **No login and no TLS on Prometheus, Loki and Tempo.** The pushes cross the VCN in plain HTTP; the hub relies on the VCN, its
  firewall, the Security List and `tailnet-guard.sh`. Tailscale's own rules also accept every tailnet device on the hub's ports: give
  admin devices only port 22 on the hub with a Tailscale ACL. Logs can hold secrets that an app prints: treat the monitoring VM as
  sensitive as the main VM.
- **cloudflared on the monitoring VM is not pinned.** Cloudflare's package repository keeps only its newest version.
- **The hub's backups stay on the monitoring VM** until you copy one off
  ([OPERATIONS.md](OPERATIONS.md#hub-backups-and-recovery)), and its metrics and logs are never backed up.
- **No alerting by default.** Grafana sends nothing until contact points and rules are added
  ([OPERATIONS.md](OPERATIONS.md#what-to-monitor) lists the minimum set). The Cloudflare tunnel alert (B8) is the only one by default.
