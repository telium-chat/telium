#!/usr/bin/env bash
#
# Put HTTPS in front of a native Telium homeserver using Caddy, which fetches
# and renews its own certificates. Run by install-native.sh when you say yes to
# "Set up HTTPS", and safe to run by itself later on a server that is already
# installed -- no repository checkout needed:
#
#   curl -fsSLo /tmp/telium-setup-caddy.sh https://raw.githubusercontent.com/telium-chat/telium/main/deploy/setup-caddy.sh
#   sudo bash /tmp/telium-setup-caddy.sh            # uses the name from /etc/telium/telium.toml
#   sudo bash /tmp/telium-setup-caddy.sh chat.example.com
#
# Before it works: DNS for the domain must point at this machine, and ports 80
# and 443 must be reachable from the internet (Caddy proves ownership of the
# name over them). Installing Caddy uses apt, so this automatic path is for
# Debian and Ubuntu; elsewhere install Caddy yourself and rerun this script.
#
# It never overwrites a Caddy configuration you wrote. If /etc/caddy/Caddyfile
# is not the one the package ships, the Telium block is saved beside it and you
# are told the one line to add.

set -euo pipefail

CONF=/etc/telium/telium.toml
CADDYFILE=/etc/caddy/Caddyfile
SNIPPET=/etc/caddy/telium.caddy

say()  { printf '  %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (for example: sudo bash $0)"
command -v systemctl >/dev/null 2>&1 || die "this needs a Linux machine running systemd"

# Take the name from the argument, or from the server's own config.
read_conf() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]+)\"[[:space:]]*(#.*)?\$/\\1/p" "$CONF" 2>/dev/null | head -n 1
}
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(read_conf server_name)"
  [ -n "$DOMAIN" ] || die "could not find the server name; pass it: bash $0 chat.example.com"
fi
DOMAIN="${DOMAIN,,}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$DOMAIN" == *.* ]] ||
  die "'$DOMAIN' does not look like a domain name"
if [ -f "$CONF" ] && [ "$(read_conf server_name)" != "$DOMAIN" ]; then
  die "this server is configured as '$(read_conf server_name)', not '$DOMAIN'"
fi

printf '\n== Setting up HTTPS for %s with Caddy\n' "$DOMAIN"

# Caddy must be able to use ports 80 and 443. If something else already
# listens there and it is not Caddy, stop rather than break that service.
if command -v ss >/dev/null 2>&1; then
  busy="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)"
  if [ -n "$busy" ]; then
    die "another program is already using port 80 or 443, so Caddy cannot start. Stop it or point it at 127.0.0.1:8448 yourself (see https://docs.telium.chat/self-hosting/exposing/)"
  fi
fi

# A name that does not resolve yet is the usual reason HTTPS fails at first.
if ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  say "note: $DOMAIN does not point anywhere yet. Add a DNS record for it that points at"
  say "this machine; Caddy keeps retrying and will finish once DNS has caught up."
fi

if ! command -v caddy >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 ||
    die "Caddy is not installed, and this script only installs it on Debian/Ubuntu. Install Caddy (https://caddyserver.com/docs/install), then rerun this script"
  say "installing Caddy (apt-get install caddy)..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null ||
    die "could not install Caddy with apt-get; install it yourself (https://caddyserver.com/docs/install) and rerun this script"
fi

# Uploads must fit through the proxy: the largest file the server accepts,
# plus room for the multipart wrapper. Otherwise Caddy rejects big uploads
# with an error the server never sees.
max_mib=128
file_max="$(read_conf max_file_bytes)"
case "$file_max" in
  *GiB) [[ "${file_max%GiB}" =~ ^[0-9]+$ ]] && max_mib=$(( ${file_max%GiB} * 1024 + 16 )) ;;
  *MiB) [[ "${file_max%MiB}" =~ ^[0-9]+$ ]] && max_mib=$(( ${file_max%MiB} + 16 )) ;;
esac

block="$(cat <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:8448 {
		# Realtime connections sit idle between heartbeats; never time them out.
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
	# Largest upload the server accepts, plus a little for the request wrapper.
	request_body {
		max_size ${max_mib}MiB
	}
	encode zstd gzip
}
EOF
)"

# Is the existing Caddyfile ours to replace? Only if absent, empty, or the
# stock file the package installs.
is_stock() {
  [ ! -s "$CADDYFILE" ] || grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$CADDYFILE"
}

install -d -m 755 /etc/caddy
imported_by_hand=0
if is_stock; then
  printf '# Written by Telium setup. Caddy gets and renews the certificate itself.\n%s\n' "$block" > "$CADDYFILE"
  say "wrote $CADDYFILE"
elif grep -qE "^[[:space:]]*$DOMAIN[[:space:],{]" "$CADDYFILE"; then
  say "$CADDYFILE already has a site for $DOMAIN; left alone"
else
  printf '# Written by Telium setup.\n%s\n' "$block" > "$SNIPPET"
  say "$CADDYFILE already has your own settings, so it was not changed."
  say "The Telium site was saved to $SNIPPET instead. To use it, add this line"
  say "to $CADDYFILE and run: systemctl reload caddy"
  say "    import $SNIPPET"
  imported_by_hand=1
fi

if [ "$imported_by_hand" -eq 0 ]; then
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 ||
    die "Caddy rejected the configuration; run: caddy validate --config $CADDYFILE --adapter caddyfile"
  systemctl enable --now caddy >/dev/null 2>&1 || die "could not start Caddy; look at: journalctl -u caddy -n 50"
  systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy ||
    die "could not reload Caddy; look at: journalctl -u caddy -n 50"
  say "Caddy is running"
else
  # Caddy is not serving this site until the import line is added by hand.
  exit 4
fi

# Getting the first certificate takes a few seconds. Try for about a minute.
say "waiting for the certificate (this can take up to a minute)..."
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS --max-time 10 "https://$DOMAIN/.well-known/telium/server" >/dev/null 2>&1; then
    say "HTTPS is working: https://$DOMAIN/.well-known/telium/server"
    exit 0
  fi
  sleep 5
done

say "HTTPS is not answering yet. Common causes:"
say "  - DNS for $DOMAIN does not point at this machine yet (can take a while)"
say "  - ports 80 and 443 are blocked by a firewall or your hosting provider's panel"
say "Caddy keeps retrying by itself. See what it is doing with: journalctl -u caddy -n 50"
say "Then check again with: curl -fsS https://$DOMAIN/.well-known/telium/server"
exit 3
