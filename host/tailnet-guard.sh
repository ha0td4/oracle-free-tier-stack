#!/usr/bin/env bash
# Installs a systemd unit that keeps containers off the hub's ports 9090, 3100, 4317 and 4318 on private addresses (10.0.0.0/8,
# 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7): REJECT rules in the STACK-TAILNET chain, jumped to from DOCKER-USER.
# The host and its host-network Alloy are not affected.
# setup-host.sh runs this; safe to re-run: sudo bash host/tailnet-guard.sh
# Exit codes: 0 ok, 1 error (not root, or the rules could not be applied).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo" >&2; exit 1; }

install -d -m 755 /usr/local/sbin
cat >/usr/local/sbin/stack-tailnet-guard <<'EOF'
#!/bin/sh
# stack-tailnet-guard start|stop: written by host/tailnet-guard.sh, run by stack-tailnet-guard.service.
set -u
CHAIN=STACK-TAILNET
PORTS=9090,3100,4317,4318
V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"
V6="fc00::/7"

# fill IPTABLES "RANGE...": STACK-TAILNET (re)filled, and jumped to from the top of DOCKER-USER once
fill() {
  "$1" -N "$CHAIN" 2>/dev/null || true
  "$1" -F "$CHAIN" || return 1
  # Traffic that stays on a Docker bridge (container to container, or in to a published port) is not headed for the hub
  "$1" -A "$CHAIN" -o docker0 -j RETURN || return 1
  "$1" -A "$CHAIN" -o br-+ -j RETURN || return 1
  for range in $2; do
    "$1" -A "$CHAIN" ! -i tailscale0 -p tcp -m multiport --dports "$PORTS" -m conntrack --ctstate NEW --ctorigdst "$range" \
      -j REJECT || return 1
  done
  "$1" -C DOCKER-USER -j "$CHAIN" 2>/dev/null || "$1" -I DOCKER-USER -j "$CHAIN"
}

# empty IPTABLES: the jump and the chain removed
empty() {
  while "$1" -D DOCKER-USER -j "$CHAIN" 2>/dev/null; do :; done
  "$1" -F "$CHAIN" 2>/dev/null || true
  "$1" -X "$CHAIN" 2>/dev/null || true
}

has_docker_user() { command -v "$1" >/dev/null 2>&1 && "$1" -n -L DOCKER-USER >/dev/null 2>&1; }

case "${1:-}" in
  start)
    has_docker_user iptables || { echo "stack-tailnet-guard: no DOCKER-USER chain in iptables (is Docker running?)" >&2; exit 1; }
    fill iptables "$V4" || exit 1
    # IPv6 only where Docker manages ip6tables
    if has_docker_user ip6tables; then fill ip6tables "$V6" || exit 1; fi ;;
  stop)
    empty iptables
    if command -v ip6tables >/dev/null 2>&1; then empty ip6tables; fi ;;
  *) echo "Usage: stack-tailnet-guard start|stop" >&2; exit 2 ;;
esac
exit 0
EOF
chmod 755 /usr/local/sbin/stack-tailnet-guard
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon /usr/local/sbin/stack-tailnet-guard || true; fi

cat >/etc/systemd/system/stack-tailnet-guard.service <<'EOF'
[Unit]
Description=Keep containers away from the monitoring hub's ports on private and tailnet addresses (stack)
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/stack-tailnet-guard start
ExecStop=/usr/local/sbin/stack-tailnet-guard stop

[Install]
WantedBy=docker.service
EOF

systemctl daemon-reload
systemctl enable stack-tailnet-guard.service
# restart, not enable --now: an active RemainAfterExit unit would not run its ExecStart again.
systemctl restart stack-tailnet-guard.service
echo "Containers cannot reach the hub's Prometheus, Loki and Tempo OTLP ports on private or tailnet addresses."
