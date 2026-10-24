#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run this installer with sudo/root." >&2
  echo "Example: sudo ./sfu/install.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing system packages..."
apt-get update -y
apt-get install -y curl ca-certificates nginx certbot python3-certbot-nginx   build-essential pkg-config libssl-dev openssl git python3 sudo tar

if ! id telium-sfu >/dev/null 2>&1; then
  useradd --system --home /var/lib/telium-sfu --create-home --shell /usr/sbin/nologin telium-sfu
fi

echo "[2/7] Locating Telium source..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/Cargo.toml" && -f "$SCRIPT_DIR/../telium-protocol/Cargo.toml" ]]; then
  SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  TMP_SRC="$(mktemp -d)"
  trap 'rm -rf "$TMP_SRC"' EXIT
  curl -fsSL https://github.com/telium-chat/telium/archive/refs/heads/main.tar.gz -o "$TMP_SRC/telium.tar.gz"
  tar xzf "$TMP_SRC/telium.tar.gz" -C "$TMP_SRC"
  SRC_ROOT="$TMP_SRC/telium-main"
  SCRIPT_DIR="$SRC_ROOT/sfu"
fi

echo "[3/7] Building telium-sfu..."
if ! command -v cargo >/dev/null 2>&1 || ! rustc --version 2>/dev/null | grep -Eq 'rustc 1\.(8[2-9]|9[0-9])|rustc [2-9]\.'; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source /root/.cargo/env
fi
(
  cd "$SCRIPT_DIR"
  cargo build --release --bin telium-sfu
)
install -m 0755 "$SCRIPT_DIR/target/release/telium-sfu" /usr/local/bin/telium-sfu

echo "[4/7] Installing LiveKit..."
if ! command -v livekit-server >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) lk_arch="amd64" ;;
    aarch64|arm64) lk_arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  lk_tag="$(curl -fsSL https://api.github.com/repos/livekit/livekit/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  lk_ver="${lk_tag#v}"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/livekit/livekit/releases/download/${lk_tag}/livekit_${lk_ver}_linux_${lk_arch}.tar.gz" -o "$tmp/livekit.tar.gz"
  tar xzf "$tmp/livekit.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/livekit-server" /usr/local/bin/livekit-server
  rm -rf "$tmp"
fi

echo "[5/7] Installing dashboard helper and service..."
install -d -m 0755 /usr/local/libexec
install -m 0755 "$SCRIPT_DIR/scripts/admin-helper.sh" /usr/local/libexec/telium-sfu-admin-helper
cat > /etc/sudoers.d/telium-sfu <<'EOF'
telium-sfu ALL=(root) NOPASSWD: /usr/local/libexec/telium-sfu-admin-helper
EOF
chmod 0440 /etc/sudoers.d/telium-sfu
visudo -cf /etc/sudoers.d/telium-sfu >/dev/null

install -d -o telium-sfu -g telium-sfu -m 0750 /var/lib/telium-sfu
install -d -o telium-sfu -g telium-sfu -m 0750 /var/lib/telium-sfu/state
install -d -o telium-sfu -g telium-sfu -m 0750 /var/lib/telium-sfu/livekit

CONFIG=/var/lib/telium-sfu/sfu.toml
if [[ ! -f "$CONFIG" ]]; then
  cat > "$CONFIG" <<'EOF'
bind = "127.0.0.1:7890"

[livekit]
mode = "Spawn"
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

[admin]
enabled = true
bind = "127.0.0.1:7891"
state_dir = "/var/lib/telium-sfu/state"
helper_path = "/usr/local/libexec/telium-sfu-admin-helper"
EOF
  chown telium-sfu:telium-sfu "$CONFIG"
  chmod 0640 "$CONFIG"
fi

# LiveKit credentials must survive SFU restarts. Older installer builds left
# these empty, causing telium-sfu to generate a new pair every boot. If an old
# livekit-server survived a restart, its old key no longer matched newly minted
# client tokens and LiveKit reported "invalid API key".
if grep -q '^api_key = "" <<'EOF'
[Unit]
Description=Telium SFU
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
User=telium-sfu
Group=telium-sfu
WorkingDirectory=/var/lib/telium-sfu
ExecStart=/usr/local/bin/telium-sfu --config /var/lib/telium-sfu/sfu.toml serve
Restart=always
RestartSec=2
NoNewPrivileges=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

if [[ ! -f /var/lib/telium-sfu/state/admin-password && ! -e /etc/nginx/sites-enabled/telium-sfu.conf ]]; then
  cat > /etc/nginx/sites-available/telium-sfu-bootstrap.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /admin {
        proxy_pass http://127.0.0.1:7891;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        default_type text/plain;
        return 200 "Telium SFU setup is available at /admin\n";
    }
}
EOF
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/telium-sfu-bootstrap.conf /etc/nginx/sites-enabled/telium-sfu-bootstrap.conf
  nginx -t
fi

systemctl daemon-reload
systemctl enable --now nginx
systemctl reload nginx
systemctl enable telium-sfu
systemctl restart telium-sfu

echo "[6/7] Opening required ports when UFW is active..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 7881/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
  ufw allow 50000:60000/udp >/dev/null
fi

echo "[7/7] Finishing..."
sleep 2
if [[ -f /var/lib/telium-sfu/state/admin-password ]]; then
  echo
  echo "=============================================================="
  echo "Telium SFU was updated successfully."
  echo "Your existing HTTPS configuration and admin dashboard were kept."
  echo "=============================================================="
else
  public_ip="$(curl -4fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  line="$(journalctl -u telium-sfu -n 100 --no-pager 2>/dev/null | grep 'FIRST-RUN SETUP:' | tail -1 || true)"
  if [[ -n "$line" ]]; then
    url="$(printf '%s\n' "$line" | sed -n 's/.*open \(http[^ ]*\).*/\1/p')"
    url="${url/http:\/\/SERVER_IP:7891/http:\/\/$public_ip}"
    echo
    echo "=============================================================="
    echo "Telium SFU is installed."
    echo
    echo "Open this one-time setup URL:"
    echo "  $url"
    echo
    echo "The wizard will create your admin password, configure the SFU,"
    echo "set up nginx + Let's Encrypt, and leave you with a dashboard."
    echo "=============================================================="
  else
    echo "Telium SFU started, but the setup URL was not found in the journal yet."
    echo "Run: journalctl -u telium-sfu -n 100 --no-pager"
  fi
fi
