#!/usr/bin/env bash
# Native SFU without host nginx, Certbot, firewall or apt changes.
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
PREFIX="${1:-/opt/telium-sfu}"
if [[ ! "$PREFIX" =~ ^/(opt|srv)/[A-Za-z0-9._/-]+$ ]] || [[ "$PREFIX" == *"/../"* || "$PREFIX" == *"/./"* || "$PREFIX" == *"//"* ]] \
   || [[ "$PREFIX" == *"/.." || "$PREFIX" == *"/." || "$PREFIX" == /opt || "$PREFIX" == /srv ]]; then
  echo "Choose a dedicated path under /opt or /srv, without . or .. components" >&2; exit 1
fi
check="$PREFIX"
while [[ "$check" != "/" ]]; do
  [[ ! -L "$check" ]] || { echo "Symlink in installation path: $check" >&2; exit 1; }
  check="$(dirname "$check")"
done
for cmd in curl python3 tar sha256sum openssl systemctl useradd install sed; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing $cmd. Portable mode never modifies system packages." >&2; exit 1;
  }
done
[[ -d /run/systemd/system ]] || { echo "Portable auto-updates require systemd" >&2; exit 1; }
if [[ -f /etc/systemd/system/telium-sfu.service ]] \
    && ! grep -Fq "ExecStart=$PREFIX/bin/telium-sfu " /etc/systemd/system/telium-sfu.service; then
  echo "Another Telium SFU system service is already installed. Refusing to replace it." >&2; exit 1
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/../deploy" && pwd)"
if ! id telium-sfu >/dev/null 2>&1; then
  useradd --system --home "$PREFIX" --shell /usr/sbin/nologin --no-create-home telium-sfu
fi
install -d -m 0755 "$PREFIX" "$PREFIX/bin"
install -d -o telium-sfu -g telium-sfu -m 0750 "$PREFIX/config" "$PREFIX/data" "$PREFIX/data/state" "$PREFIX/data/livekit"
install -d -m 0700 "$PREFIX/updates"
case "$(uname -m)" in
  x86_64) arch=x86_64; lk_arch=amd64 ;;
  aarch64) arch=aarch64; lk_arch=arm64 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac

# Official native releases embed the publisher signing key. Verify the
# published archive checksum before extraction; never compile an unpinned SFU.
if [[ ! -x "$PREFIX/bin/telium-sfu" ]]; then
  echo "[portable] Downloading Telium SFU release..."
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  asset="telium-sfu-linux-$arch.tar.gz"
  base="https://github.com/telium-chat/telium/releases/download/sfu-latest"
  curl -fsSL --retry 3 --max-time 900 "$base/$asset" -o "$tmp/$asset"
  curl -fsSL --retry 3 --max-time 60 "$base/$asset.sha256" -o "$tmp/$asset.sha256"
  ( cd "$tmp"; sha256sum -c "$asset.sha256" )
  tar -xzf "$tmp/$asset" -C "$tmp" telium-sfu sfu.example.toml
  install -m 0755 "$tmp/telium-sfu" "$PREFIX/bin/telium-sfu"
  install -m 0644 "$tmp/sfu.example.toml" "$PREFIX/config/sfu.example.toml"
  rm -rf "$tmp"; trap - EXIT
fi
if [[ ! -x "$PREFIX/bin/livekit-server" ]]; then
  echo "[portable] Downloading private LiveKit executable..."
  lk_tag="$(curl -fsSL --max-time 60 https://api.github.com/repos/livekit/livekit/releases/latest \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  [[ "$lk_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid LiveKit release tag" >&2; exit 1; }
  lk_ver="$(printf '%s' "$lk_tag" | cut -c2-)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 --max-time 900 \
    "https://github.com/livekit/livekit/releases/download/$lk_tag/livekit_${lk_ver}_linux_${lk_arch}.tar.gz" -o "$tmp/livekit.tar.gz"
  tar -xzf "$tmp/livekit.tar.gz" -C "$tmp" livekit-server
  install -m 0755 "$tmp/livekit-server" "$PREFIX/bin/livekit-server"
  rm -rf "$tmp"; trap - EXIT
fi

CONFIG="$PREFIX/config/sfu.toml"
if [[ ! -e "$CONFIG" ]]; then
  cat > "$CONFIG" <<'SFU_CONFIG'
bind = "127.0.0.1:7890"

[livekit]
mode = "Spawn"
url = "http://127.0.0.1:7880"
public_url = ""
api_key = ""
api_secret = ""
binary = "__PREFIX__/bin/livekit-server"
config_dir = "__PREFIX__/data/livekit"

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
bind = "127.0.0.1:7891"
state_dir = "__PREFIX__/data/state"
helper_path = ""
install_mode = "portable"
SFU_CONFIG
  sed -i "s|__PREFIX__|$PREFIX|g" "$CONFIG"
  lk_key="telium$(openssl rand -hex 8)"
  lk_secret="$(openssl rand -hex 32)"
  sed -i -e "s|^api_key = \"\"|api_key = \"$lk_key\"|" \
         -e "s|^api_secret = \"\"|api_secret = \"$lk_secret\"|" "$CONFIG"
  chown telium-sfu:telium-sfu "$CONFIG"; chmod 0600 "$CONFIG"
fi

install -m 0755 "$DEPLOY/update-sfu-native.sh" "$PREFIX/bin/update-sfu"
if [[ ! -e "$PREFIX/config/update-sfu.conf" ]]; then
  sed -e "s|^TELIUM_SFU_BIN=.*|TELIUM_SFU_BIN=$PREFIX/bin/telium-sfu|" \
      -e "s|^TELIUM_SFU_CONFIG=.*|TELIUM_SFU_CONFIG=$CONFIG|" \
      "$DEPLOY/update-sfu.conf" > "$PREFIX/config/update-sfu.conf"
  chmod 0600 "$PREFIX/config/update-sfu.conf"
fi
cat > /etc/systemd/system/telium-sfu.service <<EOF
[Unit]
Description=Telium SFU (portable)
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=telium-sfu
Group=telium-sfu
WorkingDirectory=$PREFIX/data
ExecStart=$PREFIX/bin/telium-sfu --config $CONFIG serve
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$PREFIX/config $PREFIX/data
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/telium-sfu-update-native.service <<EOF
[Unit]
Description=Portable Telium SFU updater
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
Environment=TELIUM_SFU_UPDATE_CONFIG=$PREFIX/config/update-sfu.conf
Environment=TELIUM_SFU_UPDATE_STATE=$PREFIX/updates
Environment=TELIUM_SFU_UPDATE_LOCK=$PREFIX/updates/.lock
ExecStart=$PREFIX/bin/update-sfu
TimeoutStartSec=1800
StandardOutput=journal
StandardError=journal
EOF
install -m 0644 "$DEPLOY/telium-sfu-update-native.timer" /etc/systemd/system/telium-sfu-update-native.timer
systemctl daemon-reload
systemctl enable --now telium-sfu.service
systemctl enable --now telium-sfu-update-native.timer

echo "[portable] Installed under $PREFIX. No nginx, Certbot, firewall or packages touched."
echo "[portable] Only a service account and three systemd units live outside $PREFIX."
echo "[portable] To open the private dashboard from your computer:"
echo "  ssh -L 7891:127.0.0.1:7891 USER@YOUR_SERVER"
if [[ ! -f "$PREFIX/data/state/admin-password" ]]; then
  sleep 2
  line="$(journalctl -u telium-sfu -n 100 --no-pager 2>/dev/null | grep 'FIRST-RUN SETUP:' | tail -1 || true)"
  url="$(printf '%s\n' "$line" | sed -n 's/.*open \(http[^ ]*\).*/\1/p')"
  echo "Then open: $(printf '%s' "$url" | sed 's/SERVER_IP/localhost/')"
fi
