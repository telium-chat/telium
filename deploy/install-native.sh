#!/usr/bin/env bash
#
# Put a Telium homeserver on this box as one static binary under systemd, and
# leave it updating itself.
#
# This is the native path's counterpart to install.sh, and it exists for the
# same reason that file exists: a documented sequence of nine commands gets
# skimmed, and the step that gets skipped is always the one at the bottom.
# Here the sequence is one command with the domain as its argument:
#
#   sudo ./deploy/install-native.sh chat.example.com
#
# Everything the box needs is derived from that one piece of information a
# human actually has. The config is written, not seeded-and-explained; the
# binary is downloaded from the rolling `server-latest` release and checked
# against the sha256 the release publishes; the updater and its timer go on
# with updates enabled, because a default that has to be turned on by a
# command nobody runs is not a default.
#
# What is deliberately left to a person: DNS, TLS (the server binds loopback;
# something has to front it), and registering the first account before
# closing registration. They are printed at the end, because they cannot be
# done from here and everything that can is done.
#
# Safe to run twice. What is ours -- the binary, the units, the updater --
# is replaced every time, which is how this machinery upgrades. What is
# theirs -- telium.toml, update.conf, and everything under the data and
# backup directories -- is created once and never touched again.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=telium-chat/telium
ROLLING=server-latest

BIN=/usr/local/bin/telium-server
UPDATE_BIN=/usr/local/sbin/telium-update-native
ETC=/etc/telium
CONF=$ETC/telium.toml
EXAMPLE=$ETC/telium.example.toml
UPD_CONF=$ETC/update.conf
DATA=/var/lib/telium
BACKUPS=/var/backups/telium

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the domain

# The domain is the one input, and it is worth being strict about: it becomes
# the half of every account id this server ever mints, and the check tool
# would refuse it at startup anyway -- better here, before anything is
# written, than at ExecStartPre afterwards.
[ $# -eq 1 ] || { echo "usage: sudo $0 <domain>   e.g. sudo $0 chat.example.com" >&2; exit 2; }

DOMAIN="${1#*://}"          # tolerate a pasted URL
DOMAIN="${DOMAIN%%/*}"      # drop any path
DOMAIN="${DOMAIN%.}"        # drop a trailing dot
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*) die "'$DOMAIN' does not look like a domain name" ;;
esac
case "$DOMAIN" in
  *.*) : ;;
  *) die "refusing a dotless name ($DOMAIN); the startup audit would call it a danger" ;;
esac
case "$DOMAIN" in
  localhost|localhost.*|example.com|example.org|example.net|change.me)
    die "refusing '$DOMAIN'; it is a placeholder, not a home" ;;
esac

# ------------------------------------------------------------------ the host

# Root is needed for /usr/local, /etc/systemd and the telium user. Unlike the
# container path there is no registry credential tied to an account, so no
# ordinary user has to own anything afterwards -- but running this as a login
# root shell is still worth a word, not a refusal.
[ "$(id -u)" -eq 0 ] || die "run this with sudo -- it writes to /usr/local, /etc and /var"

command -v curl      >/dev/null 2>&1 || die "curl is not installed"
command -v tar       >/dev/null 2>&1 || die "tar is not installed"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is not installed"
command -v systemctl >/dev/null 2>&1 || die "this box does not use systemd; there is no native path without it"

machine="$(uname -m)"
case "$machine" in
  x86_64)  ARCH=x86_64 ;;
  aarch64) ARCH=aarch64 ;;
  *) die "$machine is not an architecture releases are published for (x86_64, aarch64)" ;;
esac

step "Installing for chat on $DOMAIN ($machine)"

# ---------------------------------------------------------------- the binary
#
# The rolling release is the address for new installs -- the same one the
# updater will follow from its first tick. The sha256 comes from the same
# release over TLS, which makes this check about transport mistakes rather
# than about a motivated attacker; the stronger chain (the signed manifest,
# verified in the binary) takes over from the updater's first run, and every
# run after that.

step "Downloading the server"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/download/$ROLLING"
asset="telium-server-linux-$ARCH.tar.gz"

curl -fsSL --connect-timeout 15 --max-time 900 -o "$tmp/$asset" "$base/$asset" \
  || die "the download from $base failed"
curl -fsSL --connect-timeout 15 --max-time 60 -o "$tmp/SHA256SUMS-server" "$base/SHA256SUMS-server" \
  || die "could not fetch the SHA256SUMS the release publishes"

grep "  $asset\$" "$tmp/SHA256SUMS-server" | (cd "$tmp" && sha256sum --check --quiet -) \
  || die "the downloaded archive does not match the sha256 the release published; it is deleted"
tar -xzf "$tmp/$asset" -C "$tmp" telium-server telium.example.toml \
  || die "the downloaded archive is not the archive it claimed to be"

# Asking the binary to name itself proves the bytes run on this kernel and
# architecture, and that the build records a commit -- which the updater will
# need to place this box in the release channel.
commit="$("$tmp/telium-server" version 2>/dev/null | sed -n 's/^commit=//p')"
[ -n "$commit" ] || die "the downloaded binary does not run here, or does not name a commit"

install -Dm755 "$tmp/telium-server" "$BIN"
install -Dm644 "$tmp/telium.example.toml" "$EXAMPLE"
say "$BIN is release ${commit:0:12}; the annotated config is at $EXAMPLE"

# ------------------------------------------------------------ user and paths

step "User and directories"

id telium >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin telium
install -d -o telium -g telium -m 750 "$DATA"
install -d -o telium -g telium -m 700 "$BACKUPS"
install -d -m 755 "$ETC"

# The whole backup story is "the archives are not inside the data" -- on the
# same filesystem that is a habit, on a different one it is a property. Say
# which one this box got.
if [ "$(stat -c %d "$DATA")" = "$(stat -c %d "$BACKUPS")" ]; then
  say "note: $BACKUPS is on the same filesystem as $DATA; a different volume or mount would survive the disk"
fi

# --------------------------------------------------------------- the config
#
# Written once, from the domain. Re-runs never touch it: it is the operator's
# from the moment it exists, and an installer that quietly reverted a hand
# edit would undo the one file a person is expected to own.

step "Configuration"

if [ -e "$CONF" ]; then
  say "$CONF already exists; left alone"
else
  install -o telium -g telium -m 600 /dev/null "$CONF"
  cat > "$CONF" <<EOF
# Written by deploy/install-native.sh for $DOMAIN. Every setting not listed
# here keeps its compiled-in default; $EXAMPLE annotates all of them.

# Identity, not a hostname: this is the half of a user id after the colon,
# and it is baked into every id and signature this server ever mints.
server_name = "$DOMAIN"

# Where clients and other servers reach us, published at
# /.well-known/telium/server. Requires the TLS that goes in front of us.
public_base_url = "https://$DOMAIN"

# Loopback only: the reverse proxy or tunnel in front of us is the public side.
bind = "127.0.0.1:8448"

database_url = "sqlite://$DATA/telium.db?mode=rwc"
media_dir = "$DATA/media"

[rate_limit]
# The proxy's address, so rate limits apply to real clients and not to it.
trusted_proxies = ["127.0.0.1"]

[backup]
# Archives outside the data directory, and the key beside them: the key is
# the whole of the restore, so it wants copying off this machine the day the
# server logs that it minted one.
dir = "$BACKUPS/archives"
key_file = "$BACKUPS/backup.key"
EOF
  say "$CONF written for $DOMAIN"
fi

# ----------------------------------------------------------------- the units

step "systemd"

install -Dm755 "$here/update-native.sh" "$UPDATE_BIN"
install -Dm644 "$here/telium-server.service"          /etc/systemd/system/telium-server.service
install -Dm644 "$here/telium-update-native.service"   /etc/systemd/system/telium-update-native.service
install -Dm644 "$here/telium-update-native.timer"     /etc/systemd/system/telium-update-native.timer

if [ -e "$UPD_CONF" ]; then
  say "$UPD_CONF already exists; left alone"
else
  cat > "$UPD_CONF" <<'EOF'
# Read by telium-update-native on every tick. Delete a line to fall back to
# its default, which is the empty value shown.
TELIUM_UPDATES=automatic
# TELIUM_PIN=            a commit to hold; empty follows the channel
# TELIUM_PIN_REASON=     why a pin is there; a pin without a reason is reported on every run
# TELIUM_UPDATE_WINDOW=  HH:MM-HH:MM; empty means any time
# TELIUM_ARTIFACT=       server-linux-x86_64 or server-linux-aarch64; empty follows this CPU
EOF
  say "$UPD_CONF written: updates are ON"
fi

systemctl daemon-reload
say "units installed"

# ------------------------------------------------------------------- check
#
# The same audit the unit runs at every start, here with the new binary
# against the new config -- so a finding is a person reading a line now
# instead of a unit that refuses to start in five minutes.

step "Checking the configuration"

if ! "$BIN" --config "$CONF" check --strict; then
  echo "error: the configuration above did not pass; fix $CONF and run $0 $DOMAIN again" >&2
  exit 1
fi

# ------------------------------------------------------------------- start

step "Starting"

systemctl enable --now telium-server.service telium-update-native.timer
say "telium-server.service and telium-update-native.timer are enabled"

# The server binds loopback, so its own health endpoint answers as soon as
# the process is up, whatever DNS and TLS are doing.
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 http://127.0.0.1:8448/_telium/v1/health >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done
[ -n "$ok" ] || die "the health endpoint on 127.0.0.1:8448 did not answer; look at: journalctl -u telium-server -n 50"
say "the server is up on 127.0.0.1:8448"

# ------------------------------------------------------------ what is left
#
# Three things, none of which a script on the box can do: DNS is a panel
# somewhere else, TLS is a choice of front (a tunnel, or a proxy with real
# certificates), and the first account has to belong to a person before
# registration closes.

step "Still to do, by hand"

say "1. point DNS: $DOMAIN -> this box's public address"
say "2. put TLS in front, one of:"
say "     a Cloudflare Tunnel (no open ports):  docs.telium.chat/self-hosting/exposing/"
say "     or Caddy on this box (real certificates): docs.telium.chat/self-hosting/exposing/"
say "   then verify:"
say "     curl -fsS https://$DOMAIN/.well-known/telium/server"
say "3. register your account (the first one becomes the admin), then close"
say "   registration: set [registration] open = false in $CONF and restart:"
say "     systemctl restart telium-server"
say ""
say "voice and video mesh up to 4 participants with no extra setup; a larger"
say "server wants an SFU: docs.telium.chat/self-hosting/sfu/"
