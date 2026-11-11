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
  if [[ -e "$check" ]]; then
    [[ "$(stat -c %u "$check")" = 0 ]] || {
      echo "Non-root-owned installation path component: $check" >&2; exit 1;
    }
    # A root-owned but group/world-writable parent can be renamed by an
    # unprivileged process while the installer performs privileged writes.
    permissions="$(stat -c %a "$check")"
    if (( (8#$permissions & 0022) != 0 )); then
      echo "Group/world-writable installation path component: $check" >&2; exit 1
    fi
  fi
  check="$(dirname "$check")"
done
for cmd in curl python3 tar sha256sum openssl systemctl useradd install sed flock runuser grep stat; do
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

# Never run a root-managed binary from a symlink or from a writable directory.
# Check every existing root-owned ancestor, including /opt or /srv.
for target in "$PREFIX" "$PREFIX/bin" "$PREFIX/updates"; do
  [[ ! -L "$target" ]] || { echo "Symlink at $target; refusing" >&2; exit 1; }
  if [[ -e "$target" ]]; then
    [[ -d "$target" && "$(stat -c %u "$target")" = 0 ]] || {
      echo "Expected root-owned directory: $target" >&2; exit 1;
    }
    mode="$(stat -c %a "$target")"
    if (( (8#$mode & 0022) != 0 )); then
      echo "Root-managed directory is group/world-writable: $target" >&2; exit 1
    fi
  fi
done
for target in "$PREFIX/bin/telium-sfu" "$PREFIX/bin/livekit-server" "$PREFIX/bin/update-sfu" \
              "$PREFIX/updates/update-sfu.conf" "$PREFIX/updates/sfu.example.toml" \
              "$PREFIX/config" "$PREFIX/data" "$PREFIX/data/state" "$PREFIX/data/livekit" \
              "$PREFIX/config/sfu.toml"; do
  [[ ! -L "$target" ]] || { echo "Symlink at $target; refusing" >&2; exit 1; }
done
for target in "$PREFIX/bin/telium-sfu" "$PREFIX/bin/livekit-server" "$PREFIX/bin/update-sfu"; do
  if [[ -e "$target" ]]; then
    [[ -f "$target" && "$(stat -c %u "$target")" = 0 ]] || {
      echo "Root-owned regular file required: $target" >&2; exit 1;
    }
    mode="$(stat -c %a "$target")"
    if (( (8#$mode & 0022) != 0 )); then
      echo "Root-managed executable is group/world-writable: $target" >&2; exit 1
    fi
  fi
done

# Fail before creating users, directories or units if sfu-latest is too old.
# Both the portable dashboard and the hardened native updater are required.
require_compatible_sfu() {
  local version_output
  version_output="$("$1" version)" || { echo "Unable to inspect SFU release: $1" >&2; return 1; }
  if ! grep -Fxq 'portable_native_installer=1' <<< "$version_output" \
      || ! grep -Fxq 'publisher_key_embedded=true' <<< "$version_output"; then
    echo "This SFU release lacks portable installer support or its pinned signing key." >&2
    echo "Publish a new signed SFU release containing this PR before installing portable mode." >&2
    return 1
  fi
}
tmp=""
if [[ -x "$PREFIX/bin/telium-sfu" ]]; then
  require_compatible_sfu "$PREFIX/bin/telium-sfu"
else
  echo "[portable] Checking latest signed Telium SFU release for portable support..."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64) arch=aarch64 ;;
    *) echo "Unsupported architecture" >&2; exit 1 ;;
  esac
  asset="telium-sfu-linux-$arch.tar.gz"
  base="https://github.com/telium-chat/telium/releases/download/sfu-latest"
  curl -fsSL --retry 3 --max-time 900 "$base/$asset" -o "$tmp/$asset"
  curl -fsSL --retry 3 --max-time 60 "$base/$asset.sha256" -o "$tmp/$asset.sha256"
  ( cd "$tmp"; sha256sum -c "$asset.sha256" )
  tar -xzf "$tmp/$asset" -C "$tmp" telium-sfu sfu.example.toml
  chmod 0755 "$tmp/telium-sfu"
  require_compatible_sfu "$tmp/telium-sfu"
fi

if ! id telium-sfu >/dev/null 2>&1; then
  useradd --system --home "$PREFIX" --shell /usr/sbin/nologin --no-create-home telium-sfu
fi
# Only create/chown directory entries whose immediate parent is root-owned.
# In particular, never run root's 'install -d -o ...' below writable data/.
install -d -o root -g root -m 0755 "$PREFIX" "$PREFIX/bin"
install -d -o root -g root -m 0700 "$PREFIX/updates"
new_config_dir=0
if [[ ! -e "$PREFIX/config" ]]; then
  install -d -o root -g root -m 0700 "$PREFIX/config"
  new_config_dir=1
else
  [[ -d "$PREFIX/config" && "$(stat -c %u "$PREFIX/config")" = "$(id -u telium-sfu)" ]] || {
    echo "Existing config directory must belong to telium-sfu: $PREFIX/config" >&2; exit 1;
  }
fi
if [[ ! -e "$PREFIX/data" ]]; then
  install -d -o telium-sfu -g telium-sfu -m 0750 "$PREFIX/data"
else
  [[ -d "$PREFIX/data" && "$(stat -c %u "$PREFIX/data")" = "$(id -u telium-sfu)" ]] || {
    echo "Existing data directory must belong to telium-sfu: $PREFIX/data" >&2; exit 1;
  }
fi
# The service account creates its own state: root never traverses a
# service-writable path while chmod-ing or chown-ing directories.
for name in state livekit; do
  target="$PREFIX/data/$name"
  if [[ ! -e "$target" ]]; then
    runuser -u telium-sfu -- mkdir -- "$target"
  fi
  [[ ! -L "$target" && -d "$target" && "$(stat -c %u "$target")" = "$(id -u telium-sfu)" ]] || {
    echo "Expected a real telium-sfu-owned directory: $target" >&2; exit 1
  }
done
if [[ -n "$tmp" ]]; then
  install -m 0755 "$tmp/telium-sfu" "$PREFIX/bin/telium-sfu"
  install -m 0644 "$tmp/sfu.example.toml" "$PREFIX/updates/sfu.example.toml"
  rm -rf "$tmp"; trap - EXIT
else
  [[ -f "$PREFIX/updates/sfu.example.toml" ]] ||
    install -m 0644 "$HERE/sfu.example.toml" "$PREFIX/updates/sfu.example.toml"
fi
if [[ ! -x "$PREFIX/bin/livekit-server" ]]; then
  echo "[portable] Downloading private LiveKit executable..."
  case "$(uname -m)" in
    x86_64) lk_arch=amd64 ;;
    aarch64) lk_arch=arm64 ;;
    *) echo "Unsupported architecture" >&2; exit 1 ;;
  esac
  lk_tag="$(curl -fsSL --max-time 60 https://api.github.com/repos/livekit/livekit/releases/latest \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  [[ "$lk_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid LiveKit release tag" >&2; exit 1; }
  lk_ver="${lk_tag#v}"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 --max-time 900 \
    "https://github.com/livekit/livekit/releases/download/$lk_tag/livekit_${lk_ver}_linux_${lk_arch}.tar.gz" -o "$tmp/livekit.tar.gz"
  tar -xzf "$tmp/livekit.tar.gz" -C "$tmp" livekit-server
  install -m 0755 "$tmp/livekit-server" "$PREFIX/bin/livekit-server"
  rm -rf "$tmp"; trap - EXIT
fi

CONFIG="$PREFIX/config/sfu.toml"
[[ ! -L "$CONFIG" ]] || { echo "Refusing symlinked SFU config: $CONFIG" >&2; exit 1; }
[[ ! -L "$PREFIX/updates/update-sfu.conf" ]] || {
  echo "Refusing symlinked privileged update config" >&2; exit 1;
}
if [[ ! -e "$CONFIG" ]]; then
  # Never write as root inside an existing service-writable config directory.
  if [[ "$new_config_dir" != 1 ]]; then
    echo "Missing sfu.toml in an existing service-writable config directory. Refusing unsafe root write." >&2
    exit 1
  fi
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
# Hand over config/ only after initial secrets have been written.
if [[ "$new_config_dir" = 1 ]]; then
  chown telium-sfu:telium-sfu "$PREFIX/config"
  chmod 0750 "$PREFIX/config"
fi

install -m 0755 "$DEPLOY/update-sfu-native.sh" "$PREFIX/bin/update-sfu"
if [[ ! -e "$PREFIX/updates/update-sfu.conf" ]]; then
  sed -e "s|^TELIUM_SFU_BIN=.*|TELIUM_SFU_BIN=$PREFIX/bin/telium-sfu|" \
      -e "s|^TELIUM_SFU_CONFIG=.*|TELIUM_SFU_CONFIG=$CONFIG|" \
      -e "s|^TELIUM_SFU_MANIFEST_URL=.*|TELIUM_SFU_MANIFEST_URL=|" \
      "$DEPLOY/update-sfu.conf" > "$PREFIX/updates/update-sfu.conf"
  printf '\nTELIUM_SFU_USAGE_LEDGER=%s/data/livekit/usage.json\n' "$PREFIX" >> "$PREFIX/updates/update-sfu.conf"
  printf 'TELIUM_SFU_EXAMPLE_CONFIG=%s/updates/sfu.example.toml\n' "$PREFIX" >> "$PREFIX/updates/update-sfu.conf"
  printf 'TELIUM_SFU_TRUSTED_NATIVE=1\n' >> "$PREFIX/updates/update-sfu.conf"
fi
# A rerun from an early portable preview must also enforce the new trusted
# native updater policy; never silently retain its service-writable source.
if ! grep -Fxq 'TELIUM_SFU_TRUSTED_NATIVE=1' "$PREFIX/updates/update-sfu.conf"; then
  printf '\nTELIUM_SFU_TRUSTED_NATIVE=1\n' >> "$PREFIX/updates/update-sfu.conf"
fi
if ! grep -Fq 'TELIUM_SFU_EXAMPLE_CONFIG=' "$PREFIX/updates/update-sfu.conf"; then
  printf 'TELIUM_SFU_EXAMPLE_CONFIG=%s/updates/sfu.example.toml\n' "$PREFIX" >> "$PREFIX/updates/update-sfu.conf"
fi
chmod 0600 "$PREFIX/updates/update-sfu.conf"
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
Environment=TELIUM_SFU_UPDATE_CONFIG=$PREFIX/updates/update-sfu.conf
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
