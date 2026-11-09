#!/usr/bin/env bash
#
# Put a Telium SFU's compose deploy machinery on this box, and leave it
# updating itself. The relay's counterpart to install.sh, and the container
# sibling of sfu/install.sh (which is the native, no-Docker path).
#
# This file exists for the same reason the server's does: "updates are on by
# default" cannot be true of a documented sequence of commands. Here it is
# not a step that can be missed; it is what running this does. Opting out is
# still one word -- TELIUM_SFU_UPDATES=manual in /opt/telium-sfu/update-sfu.conf,
# which this script installs precisely so the choice has somewhere to live.
#
# Safe to run twice. It never overwrites a file that is the operator's -- the
# config, the compose file, the conf -- and says so when it declines. The
# files that are ours (the updater script, the reference config, the units)
# are replaced every time, which is how an upgrade of this machinery happens.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX=/opt/telium-sfu

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- who, and what

[ "$(id -u)" -eq 0 ] || die "run this with sudo -- it writes to /opt and /etc/systemd/system"

RUN_AS="${TELIUM_RUN_AS:-${SUDO_USER:-}}"
[ -n "$RUN_AS" ] || die "cannot tell which account should own this. Re-run with sudo, or set TELIUM_RUN_AS=<user>"
[ "$RUN_AS" != "root" ] || die "refusing to run the deploy as root; set TELIUM_RUN_AS to an ordinary account"
id -u "$RUN_AS" >/dev/null 2>&1 || die "no such user: $RUN_AS"

RUN_GROUP="$(id -gn "$RUN_AS")"

command -v docker    >/dev/null 2>&1 || die "docker is not installed"
command -v systemctl >/dev/null 2>&1 || die "this box does not use systemd; the timer has no equivalent here"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"

step "Installing for $RUN_AS ($RUN_GROUP)"

# ------------------------------------------------------------------- the files

step "Files"
install -d -o "$RUN_AS" -g "$RUN_GROUP" "$PREFIX"

# Ours. Replaced on every run, because that is what upgrading this machinery is.
install -o "$RUN_AS" -g "$RUN_GROUP" -m 755 "$here/update-sfu.sh" "$PREFIX/update-sfu.sh"
install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$here/../sfu/sfu.example.toml" "$PREFIX/sfu.example.toml"
install -m 755 "$here/update-sfu.sh" /usr/local/sbin/telium-update-sfu
say "update-sfu.sh, sfu.example.toml"

# Theirs. Seeded once and never touched again -- these are the files an
# operator edits, and an installer that quietly reverted a hand-tuned compose
# file would be doing the exact thing update-sfu.sh goes to such lengths to
# avoid.
for f in compose.yml sfu.toml update-sfu.conf; do
  if [ -e "$PREFIX/$f" ]; then
    say "$f already exists; left alone"
  else
    case "$f" in
      compose.yml)   src="$here/compose.sfu.yml" ;;
      sfu.toml)      src="" ;;
      update-sfu.conf) src="$here/update-sfu.conf" ;;
    esac
    if [ -n "$src" ]; then
      install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$src" "$PREFIX/$f"
    else
      # The seeded relay config: the same shape the native installer writes,
      # bound to the container's interfaces. public_url and the embedded
      # TURN/RTC settings are the dashboard setup wizard's job -- the admin
      # bootstrap URL is in the journal on first boot.
      tmp="$(mktemp)"
      cat > "$tmp" <<'EOF'
# The relay's config. This file is yours; the updater never writes it and no
# release needs it to change (every key has a default in the binary). The
# dashboard at http://127.0.0.1:7891 (published on loopback by compose.yml)
# walks through public_url, TURN and HTTPS setup.
bind = "0.0.0.0:7890"

[livekit]
mode = "spawn"
url = "http://127.0.0.1:7880"
public_url = ""
api_key = ""
api_secret = ""
binary = "/usr/local/bin/livekit-server"
config_dir = "/var/lib/telium-sfu/livekit"

[livekit.rtc]
port_range_start = 50000
port_range_end = 60000
tcp_port = 7881
use_external_ip = true

[livekit.turn]
enabled = true
udp_port = 3478

[livekit.room]
empty_timeout = 300
max_participants = 0

[trust]
discovery = true
cache_ttl_secs = 86400
public = false
origins = []

# Limits for public SFU operators. Zero means UNLIMITED, not disabled.
# Set transfer_budget_bytes to your VPS allowance (BYTES, not GB).
# New rooms stop at 80% by default; existing calls finish naturally.
# This is an estimate, not your provider's actual traffic meter.
[limits]
max_bitrate = 8000000
enforce = true
poll_interval_secs = 15
max_rooms = 0
max_participants = 0
transfer_budget_bytes = 0
transfer_period_days = 30
transfer_stop_percent = 80

[admin]
enabled = true
bind = "0.0.0.0:7891"
state_dir = "/var/lib/telium-sfu/state"
helper_path = "/usr/local/libexec/telium-sfu-admin-helper"

EOF
      install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$tmp" "$PREFIX/$f"
      rm -f "$tmp"
    fi
    say "$f installed"
  fi
done

# Seed a baseline only when the operator's compose file still exactly matches
# the one this installer shipped. Future updates can then safely reconcile it.
# Never guess a baseline for a locally edited file.
if [ ! -f "$PREFIX/.baseline/compose.yml" ] \
   && cmp -s "$PREFIX/compose.yml" "$here/compose.sfu.yml"; then
  install -d -o "$RUN_AS" -g "$RUN_GROUP" "$PREFIX/.baseline"
  install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 \
    "$here/compose.sfu.yml" "$PREFIX/.baseline/compose.yml"
  say "seeded the Compose baseline for safe future updates"
fi

# ------------------------------------------------------------------- the units

step "systemd"
install -m 644 "$here/telium-sfu-update.service" /etc/systemd/system/telium-sfu-update.service
install -m 644 "$here/telium-sfu-update.timer"   /etc/systemd/system/telium-sfu-update.timer
systemctl daemon-reload
say "units installed"

# The line this whole file exists for.
systemctl enable --now telium-sfu-update.timer
say "telium-sfu-update.timer is enabled and running"

# --------------------------------------------------------------- what is left

step "Still to do, by hand"

# The timer's service runs as root (it calls Docker and reconciles files).
# Checking an undefined RUN_HOME here used to abort the installer under set -u,
# and directing operators to login as RUN_AS did not authenticate that service.
if [ ! -s /root/.docker/config.json ]; then
  say "if the registry requires authentication, login as root for the systemd updater:"
  say "    <your password manager> | sudo docker login ghcr.io -u <user> --password-stdin"
fi

say "the compose stack has not been started yet. The native dashboard wizard"
say "cannot configure host nginx/Certbot from inside a container."
say "Set livekit.public_url in $PREFIX/sfu.toml, configure host nginx + HTTPS"
say "for the SFU and LiveKit domains, then start the stack:"
say "    cd $PREFIX && docker compose up -d"
say "Full instructions: https://github.com/telium-chat/telium/blob/main/deploy/README.md#compose-sfu-setup"
say "The dashboard is available over an SSH tunnel to localhost:7891 for"
say "administration and first-run password setup; do not expose it publicly."
say ""
say "updates are ON. $PREFIX/update-sfu.conf says so in a field with a name;"
say "'$PREFIX/update-sfu.sh --status' will tell you what this box currently thinks."
