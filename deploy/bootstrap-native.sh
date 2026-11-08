#!/usr/bin/env bash
# Download and launch the native Telium installer without requiring git, a
# checkout, or a particular working directory. Run from a saved local file.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[ "$#" -eq 1 ] || { echo "usage: bash bootstrap-native.sh <domain>   e.g. bash bootstrap-native.sh chat.example.com" >&2; exit 2; }

# A VPS root shell needs no sudo. For ordinary login accounts, use sudo when
# available, rather than requiring it on machines with no sudo package.
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo bash "$0" "$@"
  fi
  die "root privileges are needed and sudo is not installed. Log in as root (su -) and rerun the saved script, or ask your administrator to install sudo."
fi

command -v systemctl >/dev/null 2>&1 ||
  die "native installation needs a Linux machine running systemd"

# Bare Debian/Ubuntu images may lack curl, tar, and the user-management tools.
# Install only when needed; don't silently install a new init system or
# attempt unsupported package-manager guesses on other distributions.
missing=()
for tool in curl tar sha256sum runuser useradd; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -ne 0 ]; then
  say "missing tools: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    say "installing required packages with apt-get..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update &&
      apt-get install -y --no-install-recommends ca-certificates curl tar coreutils util-linux passwd ||
      die "package installation failed; repair apt and rerun the installer"
  else
    die "install the missing tools (${missing[*]}) with your distribution's package manager, then rerun"
  fi
fi
for tool in curl tar sha256sum runuser useradd; do
  command -v "$tool" >/dev/null 2>&1 ||
    die "$tool is still missing after installing prerequisites"
done

# The existing installer expects these companion files beside itself. Fetch
# all of them *before* invoking it, so a failed download cannot leave a
# half-configured server. The installer verifies the server release separately.
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
base=https://raw.githubusercontent.com/telium-chat/telium/main/deploy
for file in install-native.sh update-native.sh telium-server.service telium-update-native.service telium-update-native.timer; do
  curl -fsSL --retry 2 --connect-timeout 15 --max-time 90 -o "$tmp/$file" "$base/$file" ||
    die "could not download $file from GitHub; check network access and retry"
done

printf '\n== Starting the Telium native installer\n'
bash "$tmp/install-native.sh" "$@"
