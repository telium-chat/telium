#!/usr/bin/env bash
# Root-only proxy helper, installed by install-full.sh and run by
# `telium-sfu configure` (as root, directly or through sudo). It writes the
# SFU's and LiveKit's sites into the host's Caddy or nginx and gets
# certificates. Nothing else is allowed to call it: the sudoers entry that once
# let the service account do so is removed on install.
set -euo pipefail

fail() { echo "telium-sfu helper: $*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || fail "must run as root"

valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] &&
  [[ "$1" == *.* ]] &&
  [[ "$1" != *..* ]]
}

cmd="${1:-}"
case "$cmd" in
  proxy)
    sfu_domain="${2:-}"
    livekit_domain="${3:-}"
    email="${4:-}"

    valid_domain "$sfu_domain" || fail "invalid SFU domain"
    valid_domain "$livekit_domain" || fail "invalid LiveKit domain"
    [[ "$email" == *@*.* ]] || fail "invalid Let's Encrypt email"

    proxy_kind="$(cat /etc/telium/sfu-proxy 2>/dev/null || echo nginx)"
    if [[ "$proxy_kind" == caddy ]]; then
      snippet=/etc/caddy/telium-sfu.caddy
      previous=""
      if [[ -f "$snippet" ]]; then previous="$(mktemp)"; cp -p "$snippet" "$previous"; fi
      cat > "$snippet" <<CADDY
# Written by Telium SFU setup. Caddy gets and renews the certificates itself.
$sfu_domain {
	reverse_proxy 127.0.0.1:7890
}

$livekit_domain {
	reverse_proxy 127.0.0.1:7880 {
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
CADDY
      if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
        if [[ -n "$previous" ]]; then cp -p "$previous" "$snippet"; else rm -f "$snippet"; fi
        rm -f "$previous"
        fail "Caddy rejected the new site configuration; the previous one was restored"
      fi
      rm -f "$previous"
      systemctl reload caddy
    else
    cat > /etc/nginx/sites-available/telium-sfu.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $sfu_domain;

    location / {
        proxy_pass http://127.0.0.1:7890;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name $livekit_domain;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }
}
EOF

    rm -f /etc/nginx/sites-enabled/telium-sfu-bootstrap.conf
    rm -f /etc/nginx/sites-available/telium-sfu-bootstrap.conf
    ln -sfn /etc/nginx/sites-available/telium-sfu.conf /etc/nginx/sites-enabled/telium-sfu.conf
    nginx -t
    systemctl reload nginx

    certbot --nginx --non-interactive --agree-tos --email "$email" --redirect       -d "$sfu_domain" -d "$livekit_domain"

    nginx -t
    systemctl reload nginx

    fi

    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
      ufw allow 80/tcp >/dev/null
      ufw allow 443/tcp >/dev/null
      ufw allow 7881/tcp >/dev/null
      ufw allow 3478/udp >/dev/null
      ufw allow 50000:60000/udp >/dev/null
    fi

    echo "proxy and certificates configured"
    ;;
  *)
    fail "usage: $0 proxy <sfu-domain> <livekit-domain> <email>"
    ;;
esac
