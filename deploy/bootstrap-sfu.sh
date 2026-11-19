#!/usr/bin/env bash
# Download and launch the SFU installer without git, a checkout, or a Rust
# toolchain. Fetches only the installer's companion files (a few small
# scripts); the telium-sfu binary itself is a checksummed release download.
# Run from a saved local file:  sudo bash bootstrap-sfu.sh
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo bash "$0" "$@"
  fi
  die "root privileges are needed and sudo is not installed. Log in as root and rerun."
fi

command -v systemctl >/dev/null 2>&1 || die "this installer needs a Linux machine that uses systemd"

missing=()
for tool in curl tar sha256sum python3; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -ne 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "  installing missing tools: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update &&
      apt-get install -y --no-install-recommends ca-certificates curl tar coreutils python3 ||
      die "package installation failed; repair apt and rerun"
  else
    die "please install (${missing[*]}) with your package manager, then rerun"
  fi
fi

# Rebuild just enough of the repository layout for the installer, and fetch
# every file before running anything so a failed download changes nothing.
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
base=https://raw.githubusercontent.com/telium-chat/telium/main
mkdir -p "$tmp/sfu/scripts" "$tmp/deploy"
files=(
  sfu/install-full.sh
  sfu/install-portable.sh
  sfu/sfu.example.toml
  sfu/scripts/install-wizard.py
  sfu/scripts/admin-helper.sh
  deploy/update-sfu-native.sh
  deploy/update-sfu.conf
  deploy/telium-sfu-update-native.service
  deploy/telium-sfu-update-native.timer
)
for file in "${files[@]}"; do
  curl -fsSL --retry 2 --connect-timeout 15 --max-time 90 -o "$tmp/$file" "$base/$file" ||
    die "could not download $file from GitHub; check this machine's internet connection"
done

printf '\n== Starting the Telium SFU installer\n'
python3 "$tmp/sfu/scripts/install-wizard.py" --source-root "$tmp"
