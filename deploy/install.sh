#!/usr/bin/env bash
#
# Put a Telium homeserver's deploy machinery on this box, and leave it updating
# itself.
#
# This file exists because "updates are on by default" cannot be true of a
# documented sequence of nine commands. A reader who follows a README skips
# lines, and the line they skip is the one at the bottom that turns the timer
# on -- so the default was only ever a default for people who read carefully on
# a good day. Here it is not a step that can be missed; it is what running this
# does.
#
# Opting out is still entirely possible and takes one word: set
# TELIUM_UPDATES=manual in /opt/telium/update.conf afterwards, which this script
# installs precisely so that the choice has somewhere named to live. What is no
# longer possible is ending up unattended by accident.
#
# Safe to run twice. It never overwrites a file that is the operator's -- the
# config, the compose file, the tunnel token -- and says so when it declines.
# The files that are ours (the scripts, the units) are replaced every time,
# which is how an upgrade of this machinery happens: pull the repository, run
# this again.
#
# An optional domain argument -- `sudo ./install.sh chat.example.com` -- is
# written into a freshly seeded telium.toml, so the config that comes up is
# this deployment's rather than the staging box's. The native path has its
# own installer, install-native.sh, which takes the domain the same way.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX=/opt/telium
BACKUPS=/srv/telium-backups

# The uid inside the container, fixed in the Dockerfile. The backup directory
# has to be owned by it before the first start or every backup fails with a
# permission error that the operator finds out about from the logs, eventually.
CONTAINER_UID=10001

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- who, and what

# Root is needed for /opt, /srv and systemd, but the unit must *not* run as
# root: the registry credential lives in a particular user's ~/.docker, and a
# root unit would not find it and every pull would fail as unauthenticated. So
# the script wants sudo and the account that invoked it, separately.
[ "$(id -u)" -eq 0 ] || die "run this with sudo -- it writes to /opt, /srv and /etc/systemd/system"

RUN_AS="${TELIUM_RUN_AS:-${SUDO_USER:-}}"
[ -n "$RUN_AS" ] || die "cannot tell which account should own this. Re-run with sudo, or set TELIUM_RUN_AS=<user>"
[ "$RUN_AS" != "root" ] || die "refusing to run the deploy as root; set TELIUM_RUN_AS to an ordinary account"
id -u "$RUN_AS" >/dev/null 2>&1 || die "no such user: $RUN_AS"

RUN_GROUP="$(id -gn "$RUN_AS")"
RUN_HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || die "user $RUN_AS has no home directory, so docker login has nowhere to have written"

command -v docker    >/dev/null 2>&1 || die "docker is not installed"
command -v systemctl >/dev/null 2>&1 || die "this box does not use systemd; the timer has no equivalent here"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"

# An optional domain: the one fact about this deployment a human has and the
# config cannot guess. Given, it is written into the freshly seeded
# telium.toml so the box comes up knowing its own name; left out, the seeded
# file keeps its placeholder values and has to be edited by hand before the
# server means anything. An existing telium.toml is never touched, with or
# without the argument -- it is the operator's from the moment it exists.
DOMAIN=
if [ $# -gt 0 ]; then
  [ $# -eq 1 ] || { echo "usage: sudo $0 [domain]   e.g. sudo $0 chat.example.com" >&2; exit 2; }
  DOMAIN="${1#*://}"          # tolerate a pasted URL
  DOMAIN="${DOMAIN%%/*}"      # drop any path
  DOMAIN="${DOMAIN%.}"        # drop a trailing dot
  case "$DOMAIN" in
    *[!a-zA-Z0-9.-]*) die "'$DOMAIN' does not look like a domain name" ;;
    *.*) : ;;
    *) die "refusing a dotless name ($DOMAIN)" ;;
  esac
fi

step "Installing for $RUN_AS ($RUN_GROUP), home $RUN_HOME${DOMAIN:+, domain $DOMAIN}"

# ------------------------------------------------------------------- the files

step "Files"
install -d -o "$RUN_AS" -g "$RUN_GROUP" "$PREFIX"

# Ours. Replaced on every run, because that is what upgrading this machinery is.
install -o "$RUN_AS" -g "$RUN_GROUP" -m 755 "$here/update.sh"   "$PREFIX/update.sh"
install -o "$RUN_AS" -g "$RUN_GROUP" -m 755 "$here/netguard.sh" "$PREFIX/netguard.sh"
install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$here/../server/telium.example.toml" \
                                            "$PREFIX/telium.example.toml"
say "update.sh, netguard.sh, telium.example.toml"

# Theirs. Seeded once and never touched again -- these are the two files an
# operator edits, and an installer that quietly reverted a hand-tuned compose
# file would be doing the exact thing update.sh goes to such lengths to avoid.
for f in compose.yml telium.toml update.conf; do
  if [ -e "$PREFIX/$f" ]; then
    say "$f already exists; left alone"
  else
    install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$here/$f" "$PREFIX/$f"
    say "$f installed"
    [ "$f" = telium.toml ] && seeded_toml=1 || true
  fi
done

# The seeded config is the staging box's file; its identity lines are the two
# that cannot stay. Rewritten through install rather than sed -i so the file
# keeps the owning account -- sed -i would silently hand it to root, and the
# update timer that runs as that account would lose the ability to reconcile
# the file it reconciles.
if [ -n "$DOMAIN" ] && [ "${seeded_toml:-0}" -eq 1 ]; then
  tmp="$(mktemp)"
  sed -e "s|^server_name = .*|server_name = \"$DOMAIN\"|" \
      -e "s|^public_base_url = .*|public_base_url = \"https://$DOMAIN\"|" \
      "$here/telium.toml" > "$tmp"
  install -o "$RUN_AS" -g "$RUN_GROUP" -m 644 "$tmp" "$PREFIX/telium.toml"
  rm -f "$tmp"
  say "telium.toml installed with identity $DOMAIN"
elif [ -n "$DOMAIN" ]; then
  say "telium.toml already existed, so $DOMAIN was not applied to it"
fi

# ----------------------------------------------------------------- the backups

step "Backups"
if [ -d "$BACKUPS" ]; then
  say "$BACKUPS already exists; ownership left as it is"
else
  install -d -o "$CONTAINER_UID" -g "$CONTAINER_UID" -m 700 "$BACKUPS"
  say "$BACKUPS created, owned by the container's uid"
fi

# ------------------------------------------------------------------- the units

# The shipped units name the account this repository's own staging box uses.
# Substituted here rather than shipped as a template, so that the files in git
# stay readable as the real thing and `systemctl cat` on the box shows the
# account it is actually running as.
step "systemd"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sed -e "s|^User=.*|User=$RUN_AS|" \
    -e "s|^Group=.*|Group=$RUN_GROUP|" \
    -e "s|^Environment=HOME=.*|Environment=HOME=$RUN_HOME|" \
    "$here/telium-update.service" > "$tmp/telium-update.service"

install -m 644 "$tmp/telium-update.service" /etc/systemd/system/telium-update.service
install -m 644 "$here/telium-update.timer"      /etc/systemd/system/telium-update.timer
install -m 644 "$here/telium-netguard.service"  /etc/systemd/system/telium-netguard.service
systemctl daemon-reload
say "units installed"

# The line this whole file exists for.
systemctl enable --now telium-netguard.service telium-update.timer
say "telium-netguard.service and telium-update.timer are enabled and running"

# --------------------------------------------------------------- what is left

# Two credentials, neither of which can come from a repository, and one config
# that has to be read by a human before the hostname is public. Printed rather
# than prompted for: a script that asks for a token interactively is a script
# people paste tokens into over SSH.
step "Still to do, by hand"

if [ ! -s "$PREFIX/tunnel.env" ]; then
  say "the Cloudflare tunnel token:"
  say "    printf 'TUNNEL_TOKEN=%s\\n' \"\$TOKEN\" > $PREFIX/tunnel.env && chmod 600 $PREFIX/tunnel.env"
fi

if [ ! -s "$RUN_HOME/.docker/config.json" ]; then
  say "the registry credential (read:packages only), as $RUN_AS, not root:"
  say "    <your password manager> | docker login ghcr.io -u <user> --password-stdin"
fi

say "read $PREFIX/telium.toml before the tunnel connects -- registration.open is true,"
say "and the first account created on a fresh server becomes its admin."
if [ -n "$DOMAIN" ]; then
  say "identity is set to $DOMAIN; the rest of the file is worth a look anyway,"
  say "notably [voice], which names this deployment's SFU and is not yours."
fi
say ""
say "updates are ON. $PREFIX/update.conf says so in a field with a name;"
say "'$PREFIX/update.sh --status' will tell you what this box currently thinks."
