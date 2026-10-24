#!/usr/bin/env bash
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
  restart)
    systemctl restart --no-block telium-sfu.service
    ;;
  proxy)
    sfu_domain="${2:-}"
    livekit_domain="${3:-}"
    email="${4:-}"

    valid_domain "$sfu_domain" || fail "invalid SFU domain"
    valid_domain "$livekit_domain" || fail "invalid LiveKit domain"
    [[ "$email" == *@*.* ]] || fail "invalid Let's Encrypt email"

    cat > /etc/nginx/sites-available/telium-sfu.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $sfu_domain;

    location /admin {
        proxy_pass http://127.0.0.1:7891;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

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
    fail "usage: $0 {restart|proxy <sfu-domain> <livekit-domain> <email>}"
    ;;
esac
