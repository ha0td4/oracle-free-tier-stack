#!/usr/bin/env bash
# Host prep for Oracle Linux/RHEL 9-10 (dnf) or Ubuntu/Debian (apt). Safe to re-run.
# Usage: sudo bash host/setup-host.sh (SKIP_CROWDSEC=1 skips CrowdSec on a 1 GB machine; ALLOW_64K=1 accepts 64K pages).
# Does not close SSH port 22 (see DEPLOY.md E3).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo" >&2; exit 1; }

TZ_NAME="${TZ_NAME:-UTC}"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-4096}"
STACK_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"

step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\n[ERROR] %s\n' "$*" >&2; exit 1; }
selinux_on() { command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; }

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian)                      PM=apt ;;
  ol|rhel|rocky|almalinux|centos)     PM=dnf ;;
  *) case "${ID_LIKE:-}" in
       *debian*)        PM=apt ;;
       *rhel*|*fedora*) PM=dnf ;;
       *) die "Unsupported OS: ${PRETTY_NAME:-unknown}" ;;
     esac ;;
esac
step "OS: ${PRETTY_NAME:-unknown} | package manager: ${PM} | $(uname -m) | kernel $(uname -r)"

# 4K pages required: the 64K kernel breaks Valkey and Chromium.
PAGESIZE="$(getconf PAGESIZE)"
if [ "$PAGESIZE" != 4096 ] && [ "${ALLOW_64K:-0}" != 1 ]; then
  die "Kernel page size is ${PAGESIZE}, the stack needs 4096 (see PREPARE.md A1).
       To continue anyway (Valkey/Crawl4AI may fail): ALLOW_64K=1 sudo -E bash $0"
fi

export DEBIAN_FRONTEND=noninteractive
if [ "$PM" = apt ]; then
  step "System update and base packages (apt)"
  apt-get update
  apt-get -y upgrade
  apt-get install -y ca-certificates curl gnupg rsync openssl bzip2 nano unattended-upgrades

  step "Automatic security updates (unattended-upgrades)"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
else
  step "System update and base packages (dnf)"
  dnf -y upgrade --refresh
  # no "curl": it conflicts with curl-minimal
  dnf -y install rsync openssl bzip2 tar nano dnf-plugins-core dnf-automatic

  step "Automatic security updates (dnf-automatic)"
  if [ -f /etc/dnf/automatic.conf ]; then
    sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' \
           -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf
  fi
  systemctl enable --now dnf-automatic.timer
fi
timedatectl set-timezone "$TZ_NAME"

step "restic (pinned in versions.env)"
bash "$SCRIPT_DIR/install-restic.sh"

step "Docker"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "$PM" = apt ]; then
    curl -fsSL https://get.docker.com | sh
  else
    # conflict with the official Docker packages
    dnf -y remove podman-docker runc >/dev/null 2>&1 || true
    curl -fsSL https://download.docker.com/linux/rhel/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
    dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
fi
systemctl enable --now docker
usermod -aG docker "$STACK_USER"
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  # selinux-enabled stays off so bind mounts under data/ work without :Z labels
  cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
  systemctl restart docker
fi

step "Swap (target ${SWAP_SIZE_MB} MB)"
# Oracle Linux ships a 4G /.swapfile: add only what is missing
CUR_SWAP_BYTES=$( (swapon --noheadings --show=SIZE --bytes 2>/dev/null || true) | awk '{s+=$1} END{print s+0}')
CUR_SWAP_MB=$(( CUR_SWAP_BYTES / 1048576 ))
NEED_SWAP_MB=$(( SWAP_SIZE_MB - CUR_SWAP_MB ))
if [ "$NEED_SWAP_MB" -gt 64 ] && swapon --noheadings --show=NAME 2>/dev/null | grep -qx /swapfile; then
  # mkswap on an active swap file would corrupt it; growing it means swapoff, which can fail or stall under memory pressure
  echo "Have ${CUR_SWAP_MB} MB, ${NEED_SWAP_MB} MB short, but /swapfile is in use: not touching it." >&2
  echo "To grow it: sudo swapoff /swapfile && sudo rm /swapfile, then run this script again." >&2
elif [ "$NEED_SWAP_MB" -gt 64 ]; then
  echo "Have ${CUR_SWAP_MB} MB, adding ${NEED_SWAP_MB} MB at /swapfile"
  # An inactive leftover may have another size: start over. dd, not fallocate: works on XFS and ext4
  rm -f /swapfile
  dd if=/dev/zero of=/swapfile bs=1M count="$NEED_SWAP_MB" status=progress
  chmod 600 /swapfile
  mkswap /swapfile
  selinux_on && chcon -t swapfile_t /swapfile || true
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "Already ${CUR_SWAP_MB} MB of swap, skipping"
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -p /etc/sysctl.d/99-swappiness.conf

step "Tailscale"
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
if systemctl is-active --quiet firewalld; then
  # firewalld blocks unknown interfaces by default
  firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null
  firewall-cmd --reload >/dev/null
fi
bash "$SCRIPT_DIR/tailnet-guard.sh"

step "CrowdSec and firewall bouncer"
if [ "${SKIP_CROWDSEC:-0}" = 1 ]; then
  echo "SKIP_CROWDSEC=1: not installing CrowdSec (saves about 150 MiB of RAM; SSH is then protected only by key-only login)"
else
  if ! command -v cscli >/dev/null 2>&1; then
    curl -fsSL https://install.crowdsec.net | sh
    if [ "$PM" = apt ]; then apt-get install -y crowdsec; else dnf -y install crowdsec; fi
  fi
  if [ "$PM" = apt ]; then
    dpkg -s crowdsec-firewall-bouncer-iptables >/dev/null 2>&1 \
      || apt-get install -y crowdsec-firewall-bouncer-iptables
  else
    rpm -q crowdsec-firewall-bouncer-nftables >/dev/null 2>&1 \
      || dnf -y install crowdsec-firewall-bouncer-nftables
  fi
  cscli collections install crowdsecurity/linux >/dev/null 2>&1 || true
  systemctl reload crowdsec || systemctl restart crowdsec
fi

cat <<EOF

Done.
  OS        : ${PRETTY_NAME:-unknown}
  Page size : ${PAGESIZE}
  SELinux   : $(getenforce 2>/dev/null || echo n/a)
  firewalld : $(systemctl is-active firewalld 2>/dev/null || echo n/a)

Next:
  1. Log out and back in (docker group for '${STACK_USER}')
  2. sudo tailscale up --ssh --hostname=TS_NAME   (this host's name in your tailnet)
     Test SSH over Tailscale BEFORE closing port 22 on Oracle
  3. cd /opt/stack && bash stack.sh init

$([ "${SKIP_CROWDSEC:-0}" = 1 ] || echo "CrowdSec: sudo cscli metrics ; sudo cscli decisions list")
EOF
