#!/usr/bin/env bash
# Install the restic version pinned in versions.env to /usr/local/bin (idempotent).
# The download is checked against the SHA256SUMS file of the same GitHub release before it is installed.
# Usage: sudo ./host/install-restic.sh      (RESTIC_VERSION=x.y.z overrides versions.env)
# Exit codes: 0 installed or already there, 1 error (download, checksum mismatch, unsupported architecture).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo" >&2; exit 1; }

if [ -z "${RESTIC_VERSION:-}" ]; then
  # shellcheck source=versions.env
  . "$(dirname "$(readlink -f "$0")")/../versions.env"
fi

if /usr/local/bin/restic version 2>/dev/null | grep -q "^restic ${RESTIC_VERSION} "; then
  echo "restic ${RESTIC_VERSION} already installed"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) RARCH=arm64 ;;
  x86_64|amd64)  RARCH=amd64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}"
name="restic_${RESTIC_VERSION}_linux_${RARCH}.bz2"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$name" "$url/$name"
curl -fsSL -o "$tmp/SHA256SUMS" "$url/SHA256SUMS"
sum="$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")"
[ -n "$sum" ] || { echo "$name is not listed in the release's SHA256SUMS" >&2; exit 1; }
printf '%s  %s\n' "$sum" "$tmp/$name" | sha256sum -c --quiet || { echo "Checksum mismatch for $name: not installed" >&2; exit 1; }
bunzip2 -c "$tmp/$name" > "$tmp/restic"
install -m 755 "$tmp/restic" /usr/local/bin/restic
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon /usr/local/bin/restic || true; fi
/usr/local/bin/restic version
