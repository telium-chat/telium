#!/usr/bin/env bash
#
# Install the standalone Telium kit: the homeserver, optionally the kit's
# Caddy front, optionally the SFU, updating themselves until told not to.
#
#   sudo bash install.sh [chat.example.com]
#
# Four questions, asked only because no script can guess an answer: the
# domain, who fronts it, whether it carries voice calls. Everything else has a
# default and the default is the interesting one -- updates are ON, exactly as
# the native and tunnel installers decided before this one, because "unattended
# by accident" is only reachable here by writing TELIUM_UPDATES=manual into
# update.conf, a file that currently says the opposite.
#
# Safe to run twice. Files that are the operator's -- .env, telium.toml,
# sfu.toml, Caddyfile, update.conf, compose.yml -- are never overwritten; the
# scripts and units are, which is how an upgrade of this machinery happens.
#
# Run it with sudo from an ordinary account: that account owns /opt/telium,
# and the updater runs as it, so a `docker login` from that account is where a
# registry credential would come from if the images ever needed one.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX=/opt/telium
UNITDIR=/etc/systemd/system
# Where the kit's other files come from when this script was curled on its
# own. A checkout beside the script always wins when it exists.
RAW_BASE="https://raw.githubusercontent.com/telium-chat/telium/main/deploy/standalone"

say()  { printf '  %s\n' "$*"; }
die()  { printf '  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo from an ordinary account, not as root"
[ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] || die "could not work out which account should own the deploy"
RUN_AS="$SUDO_USER"
RUN_GROUP="$(id -gn "$RUN_AS")"

command -v docker >/dev/null 2>&1      || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
command -v systemctl >/dev/null 2>&1   || die "this box does not use systemd; the update timer has no equivalent here"

ask() { # ask <variable> <question> [default]
  local __var="$1" __q="$2" __d="${3:-}" __a
  read -rp "  $__q${__d:+ [$__d]}: " __a
  printf -v "$__var" '%s' "${__a:-$__d}"
}

echo
say "Telium -- standalone Compose install"
say

# ---------------------------------------------------------------- questions

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || ask DOMAIN "Domain users will reach, e.g. chat.example.com"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ "$DOMAIN" == *.* ]] \
  || die "'$DOMAIN' does not look like a domain name"

echo
say "Who fronts the server (TLS, port 443)?"
say "  1) the kit's Caddy container -- automatic certificates; needs ports 80+443 free"
say "  2) something already on this box -- Caddy, nginx, a tunnel; it points at 127.0.0.1:8448"
FRONT=""
while [ -z "$FRONT" ]; do
  ask FRONT "Pick 1 or 2" 1
  case "$FRONT" in 1|2) ;; *) say "'$FRONT' is not one of those; again"; FRONT="" ;; esac
done

echo
ask VOICE "Carry voice calls from this box (adds the SFU)? [y/N]" n
case "$VOICE" in y|Y|yes|YES) VOICE=y ;; *) VOICE=n ;; esac

SFU_DOMAIN="sfu.${DOMAIN}"
LIVEKIT_DOMAIN="livekit.${DOMAIN}"
if [ "$VOICE" = "y" ]; then
  echo
  say "Voice needs two extra DNS records on this box's address: media is UDP"
  say "and cannot ride the chat domain's front."
  ask SFU_DOMAIN "SFU domain (API + dashboard)" "sfu.${DOMAIN}"
  ask LIVEKIT_DOMAIN "LiveKit signalling domain" "livekit.${DOMAIN}"
fi

# ------------------------------------------------------------------- files

install -d -o "$RUN_AS" -g "$RUN_GROUP" "$PREFIX"
cd "$PREFIX"

# Files beside this script (a checkout) win; otherwise fetch them, so that
# `curl .../install.sh | sudo bash -s -- chat.example.com` works with no clone.
KIT_FILES="compose.yml Caddyfile telium.toml sfu.toml .env update.conf update.sh telium-update.service telium-update.timer"
for f in $KIT_FILES; do
  if [ ! -f "$here/$f" ]; then
    say "fetching $f"
    curl -fsSLo "$here/.fetch.$f" "$RAW_BASE/$f" || die "could not fetch $f -- run this from a checkout instead"
    mv "$here/.fetch.$f" "$here/$f"
  fi
done
chmod +x "$here/update.sh"

# The operator's files: written once, never overwritten -- compose.yml
# included, though it is ours, because a re-run that silently rewrote a
# running deployment's infrastructure file would be an update in disguise.
for f in $KIT_FILES; do
  if [ -f "$PREFIX/$f" ]; then
    say "$f already exists; left alone"
    continue
  fi
  case "$f" in
    .env|update.conf)  MODE=600 ;;
    *)                 MODE=644 ;;
  esac
  install -o "$RUN_AS" -g "$RUN_GROUP" -m "$MODE" "$here/$f" "$PREFIX/$f"
  say "$f installed"
done

# The machine's answers, written where every file reads them -- but a .env
# that already exists is the operator's; only the placeholder template is
# fresh enough to fill in.
if ! grep -q "^TELIUM_CHAT_DOMAIN=" "$PREFIX/.env" 2>/dev/null; then
  die ".env exists but does not name a domain; fix it by hand or remove it"
fi
sed -i "s|^TELIUM_CHAT_DOMAIN=.*|TELIUM_CHAT_DOMAIN=$DOMAIN|"                "$PREFIX/.env"
sed -i "s|^TELIUM_SFU_DOMAIN=.*|TELIUM_SFU_DOMAIN=$SFU_DOMAIN|"              "$PREFIX/.env"
sed -i "s|^TELIUM_LIVEKIT_DOMAIN=.*|TELIUM_LIVEKIT_DOMAIN=$LIVEKIT_DOMAIN|"  "$PREFIX/.env"

# Defaults in the shipped files assume the kit's Caddy and no SFU. Where the
# answers differ, the shipped files carry the alternative in marked blocks.
if [ "$FRONT" = "2" ]; then
  sed -i 's|^trusted_proxies = \["172.31.241.2"\]|#&|; s|^# trusted_proxies = \["172.31.241.1"\]|trusted_proxies = ["172.31.241.1"]|' \
    "$PREFIX/telium.toml"
  sed -i 's|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=|' "$PREFIX/.env"
fi
if [ "$VOICE" = "y" ]; then
  sed -i "s|chat.example.com|$DOMAIN|g; s|livekit.example.com|$LIVEKIT_DOMAIN|g" "$PREFIX/sfu.toml"
  awk '/--- Voice:/{on=1} on{sub(/^#/,"")}1' "$PREFIX/telium.toml" > "$PREFIX/.telium.toml" \
    && mv "$PREFIX/.telium.toml" "$PREFIX/telium.toml"
  sed -i 's|^COMPOSE_PROFILES=proxy$|COMPOSE_PROFILES=proxy,voice|; s|^COMPOSE_PROFILES=$|COMPOSE_PROFILES=voice|' "$PREFIX/.env"
fi
if [ "$VOICE" = "y" ] && [ "$FRONT" = "1" ]; then
  awk '/--- SFU:/{on=1} on{sub(/^#/,"")}1' "$PREFIX/Caddyfile" > "$PREFIX/.Caddyfile" \
    && mv "$PREFIX/.Caddyfile" "$PREFIX/Caddyfile"
fi
chown "$RUN_AS:$RUN_GROUP" "$PREFIX/.env" "$PREFIX/telium.toml" "$PREFIX/sfu.toml" "$PREFIX/Caddyfile" 2>/dev/null || true

# ------------------------------------------------------------------- update

install -o root -g root -m 755 "$here/update.sh" "$PREFIX/update.sh"
sed -e "s/TELIUM_RUN_AS/$RUN_AS/g" "$here/telium-update.service" > "$UNITDIR/telium-update.service"
chmod 644 "$UNITDIR/telium-update.service"
install -o root -g root -m 644 "$here/telium-update.timer" "$UNITDIR/telium-update.timer"
systemctl daemon-reload
systemctl enable --now telium-update.timer
say "telium-update.timer is enabled -- updates are ON; /opt/telium/update.conf says so in writing"

# -------------------------------------------------------------------- start

cd "$PREFIX"
say "pulling and starting${COMPOSE_PROFILES:+ (profiles: $COMPOSE_PROFILES)}${COMPOSE_PROFILES:- (server only)}"
docker compose up -d

# --------------------------------------------------------------------- done

echo
say "Done. What is where:"
say "  /opt/telium          -- this deployment; .env holds the answers you just gave"
say "  127.0.0.1:8448       -- the server; published to loopback only"
if [ "$FRONT" = "1" ]; then
  say "  https://$DOMAIN      -- live once DNS points here and Caddy has its certificate"
else
  say "  your front           -- point it at http://127.0.0.1:8448 (configs: deploy/reverse-proxy/)"
fi
if [ "$VOICE" = "y" ]; then
  say "  $SFU_DOMAIN and $LIVEKIT_DOMAIN"
  say "    need DNS -> this box; media ports open: 7881/tcp 3478/udp 50000-60000/udp"
  if [ "$FRONT" = "1" ]; then
    say "    fronted by the kit's Caddy; dashboard at https://$SFU_DOMAIN/admin"
  else
    say "    front them yourself: 7890 (API) and 7891 (/admin) and 7880 (signalling) on loopback"
  fi
  say "    SFU first-run setup URL: cd /opt/telium && docker compose logs sfu | grep FIRST-RUN"
fi
say
say "Next:"
DNS_NAMES="$DOMAIN"
[ "$VOICE" = "y" ] && DNS_NAMES="$DNS_NAMES, $SFU_DOMAIN, $LIVEKIT_DOMAIN"
say "  1. DNS: $DNS_NAMES -> this box's address"
if [ "$FRONT" = "1" ] && [ "$VOICE" = "y" ]; then
  say "     On Cloudflare: DNS-only (grey cloud) for the SFU names, or media will not flow."
fi
say "  2. Verify:  curl -fsS https://$DOMAIN/.well-known/telium/server"
say "  3. Register your account -- the FIRST account becomes the administrator --"
say "     then set [registration] open = false in /opt/telium/telium.toml and run:"
say "        cd /opt/telium && docker compose up -d"
echo
