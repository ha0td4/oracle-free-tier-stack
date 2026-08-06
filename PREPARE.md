# Prepare

Do the guides in this order. Each step ends with a **Check**: go on only when it passes.

| Steps | Guide | Result | Time | Component |
|---|---|---|---|---|
| A | Prepare (this page) | Accounts, backup buckets, a checked VM, the small monitoring VM | 50 min | always |
| B | [Cloudflare](CLOUDFLARE.md) | Tunnels, Access, routes, SSL/TLS (dashboard only) | 30 min | always |
| C, D, E | [Deploy](DEPLOY.md) | Host, running stack, every app set up, monitoring, backups, closed ports | 2 h | always |
| F | [Identity](IDENTITY.md) | Passkey login (Pocket ID) for Access and the apps | 30 min | pocket-id |
| G | [Team](TEAM.md) | Only when other people join | 1 h | hermes pocket-id |

A → E gives you a working stack for yourself. Use it a few days before F and G.

## Conventions

- **Main VM** = the A1 VM that runs the apps. **Monitoring VM** = the second, small VM (A5). **Hub** = the software on the
  monitoring VM (Prometheus, Loki, Grafana, node_exporter, cloudflared; Tempo if turned on), installed by `host/hub/deploy-hub.sh` in D8.
- **[Host]** = your computer (PowerShell on Windows). **[Remote_VM]** = the main VM, over SSH, in `/opt/stack`.
  **[Hub_VM]** = the monitoring VM, the same way.
- `UPPERCASE` names are the variables below: replace them with your values. `<NAME>` = copy it from `.env` or another screen.
- Edit files on the VM with `nano FILE` (`Ctrl+O` Enter saves, `Ctrl+X` exits).
- Pick your tier in the page header (default `standard`, [CUSTOMIZE.md](CUSTOMIZE.md#tiers)): steps for components it does not run are
  hidden. On GitHub, skip them yourself.

## Variables

Collect them as you go; **Used in** is the first step that needs each one. Keep **secrets** in a password manager and in files on the VM,
never in a command line or a chat.

| Name | What it is | Where to get it | Example | Used in | Kind |
|---|---|---|---|---|---|
| `DOMAIN` | Your domain on Cloudflare (its root stays your blog) | Cloudflare → Domains | `example.com` | B5, D1 | value |
| `PUBLIC_IP` | The VM's public IPv4 | Oracle Console → Compute → Instance | `203.0.113.10` | A1, C1 | value |
| `SSH_USER` | The image's login: `opc` (Oracle Linux) or `ubuntu` | The image you chose | `opc` | A1, C1 | value |
| `TS_NAME` | The VM's Tailscale name (you pick it in C3) | You | `oracle-vm` | C3 | value |
| `HUB_PUBLIC_IP` | The monitoring VM's public IPv4 | Oracle Console → Compute → Instance (A5) | `203.0.113.20` | A5, D8 | value |
| `HUB_SSH_USER` | The monitoring VM's login: `ubuntu` (Ubuntu, recommended in A5) or `opc` (Oracle Linux) | The image you chose (A5) | `ubuntu` | A5, D8 | value |
| `HUB_TS_NAME` | The monitoring VM's Tailscale name (you pick it in D8), for SSH | You | `observe-hub` | D8 | value |
| `HUB_PRIVATE_IP` | The monitoring VM's private IPv4 in the VCN; every other host sends its data there | Oracle Console → Compute → Instance (A5) | `192.0.2.20` | D8 | value |
| `REPO_PATH` | This repository on your Host | Your disk | `C:/Users/me/oracle-stack` | C1 | value |
| `ADMIN_EMAIL` | Your email: the Access login and every admin account of the stack | You | `admin@example.com` | B3, D1 | value |
| `CF_TEAM_NAME` | Zero Trust team name (`CF_TEAM_NAME.cloudflareaccess.com`) | Zero Trust → Settings → Team name and domain | `example-team` | D1, F2 | value |
| `OCI_NAMESPACE` | Object Storage namespace | The bucket's details (A2) | `examplenamespace` | E1 | value |
| `OCI_REGION` | Region identifier | Region menu, top of the Oracle Console (A2) | `us-ashburn-1` | E1 | value |
| `R2_ACCOUNT_ID` | Cloudflare account ID (only for an R2 second repo) | Cloudflare dashboard (A3) | `0123456789abcdef0123456789abcdef` | E1 | value |
| `B2_BUCKET`, `B2_REGION` | Bucket name and region (only for a B2 second repo) | The B2 bucket's details (A3) | `example-stack-backup` and `us-west-004` | E1 | value |
| `TELEGRAM_USER_ID` | Your numeric Telegram ID | @userinfobot (A4) | `123456789` | D6 | value |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot's token | @BotFather (A4) | `123456789:EXAMPLE-token-from-BotFather` | D6 | secret |
| `OCI_ACCESS_KEY`, `OCI_SECRET_KEY` | Customer Secret Key pair for the backup bucket | Oracle user settings (A2) | `EXAMPLEACCESSKEY` and `EXAMPLEsecret...` | E1 | secret |
| `SECONDARY_ACCESS_KEY`, `SECONDARY_SECRET_KEY` | Key pair of the second backup repo | R2 or B2 dashboard (A3) | `EXAMPLEKEYID` and `EXAMPLEsecret...` | E1 | secret |

Every other secret (app passwords, keys) is generated for you in D1.

---

## A. Accounts and the VM (VM untouched)

### A1. Check the existing VM

**[Host]**

```powershell
ssh SSH_USER@PUBLIC_IP "grep PRETTY_NAME /etc/os-release; uname -m; getconf PAGESIZE; getenforce; free -g | head -2; df -h /"
```

**Check:**

| Line | Expected | If not |
|---|---|---|
| OS | `Oracle Linux Server 10.x` (Ubuntu 22.04/24.04 also works) | Keep Oracle Linux: replacing it means recreating the instance, and free A1 capacity is often gone |
| Architecture | `aarch64` | |
| Page size | **`4096`** | See below |
| SELinux | `Enforcing` (Ubuntu: `command not found`) | Leave it as it is |
| RAM | about 11-12 GB | Less: pick a smaller tier ([CUSTOMIZE.md](CUSTOMIZE.md#tiers), or the Plan page of the guide site) |
| Disk `/` | about 30 GB free | Grow it: Compute → Instance → Boot volume → Edit, run the rescan command shown, then `sudo /usr/libexec/oci-growfs -y` |

**Page size `65536`** (64K kernel): the components that run a browser or a Redis-compatible database cannot run on it. Either

1. switch to a 4K kernel: `sudo grubby --info=ALL | grep ^kernel`, then `sudo grubby --set-default=PATH_WITHOUT_64K` and reboot (Oracle
   calls 64K → 4K *unsupported*: copy what you need first), or
2. keep it: run `setup-host.sh` with `ALLOW_64K=1` in C2 and pick a tier without the components marked "4K pages" in [CUSTOMIZE.md](CUSTOMIZE.md#components).

### A2. Oracle Object Storage (primary backup repo)

1. Console → **Storage → Object Storage → Buckets** → compartment **root** → **Create Bucket**: name `stack-backup`, tier **Standard**
   (permanent), private.
2. Open the bucket: note the **Namespace** (`OCI_NAMESPACE`) and the region identifier at the top (`OCI_REGION`).
3. **Profile → User settings → Customer Secret Keys → Generate Secret Key**, description `restic`. Copy the **Secret Key** before you leave
   the page (`OCI_SECRET_KEY`, shown once), then the **Access Key** from the list (`OCI_ACCESS_KEY`).

A bucket outside the root compartment is invisible to the S3 API: create it in root.

**Check:** namespace, region, access key and secret key are in your password manager.

### A3. Secondary backup repo (recommended, pick one)

Pick one:

- **Cloudflare R2** (10 GB free): **R2 object storage → Create bucket** `stack-backup` → **Overview → Account Details → Manage API tokens →
  Create Account API token**, permission **Object Read & Write**, this bucket only. Copy the Access Key ID (`SECONDARY_ACCESS_KEY`) and
  Secret Access Key (`SECONDARY_SECRET_KEY`), and your account ID (`R2_ACCOUNT_ID`).
- **Backblaze B2** (10 GB free): create a private bucket (`B2_BUCKET`) → **Application Keys → Add a New Application Key**, access to this
  bucket only. `keyID` = `SECONDARY_ACCESS_KEY`, `applicationKey` = `SECONDARY_SECRET_KEY` (shown once). The region (`B2_REGION`) is in the
  bucket's endpoint `s3.B2_REGION.backblazeb2.com`.

Skip it if you like: the backup then goes to Oracle only, and you add the second repo later in `backup/backup.env`.

**Check:** the key pair is in your password manager.

### A4. Tailscale and Telegram

1. Create a Tailscale account, install Tailscale on your Host, log in.
2. Telegram: **@BotFather** → `/newbot` → copy the token (`TELEGRAM_BOT_TOKEN`).
3. **@userinfobot** → copy your numeric ID (`TELEGRAM_USER_ID`).

<!-- needs: hermes -->
Hermes uses this bot (D6). For alerts kept apart from the assistant, create a second bot the same way.
<!-- /needs -->

**Check:** Tailscale shows your Host as connected, and you have the bot token and your ID.

<!-- needs: alloy -->
### A5. The monitoring VM

The hub (Grafana, with Prometheus and Loki behind it) runs on a second, small VM, so you can still see what happened when the
main VM is in trouble. The free AMD shape is enough. Oracle Console → **Compute → Instances → Create instance**:

- **Image:** **Canonical Ubuntu 24.04**, the release `deploy-hub.sh` is tested on (Ubuntu 22.04, Debian 12 and Oracle Linux / RHEL 9-10
  are best effort). **Shape:** **VM.Standard.E2.1.Micro** (*Always Free-eligible*: 1/8 OCPU, 1 GB).
- **Networking:** the main VM's VCN and subnet, with a public IPv4 (`HUB_PUBLIC_IP`). **SSH keys:** the same public key as the main VM.
- **Boot volume:** 50 GB (the default; the two VMs together stay within the 200 GB of free block storage).

**[Host]**

```powershell
ssh HUB_SSH_USER@HUB_PUBLIC_IP "grep PRETTY_NAME /etc/os-release; uname -m; free -m | head -2; df -h /"
```

**Check:** `Ubuntu 24.04`, `x86_64`, about 950 MB in the `Mem:` line, and a disk of about 50 GB. Nothing else to do on it before D8.
<!-- /needs -->

**Next:** [B. Cloudflare](CLOUDFLARE.md).
