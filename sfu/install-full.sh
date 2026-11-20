#!/usr/bin/env bash
set -euo pipefail

# Which HTTPS front end this host should use. Read-only: inspects what is
# installed and which programs already own ports 80/443, changes nothing.
# Sets PROXY_OPTIONS (valid choices), PROXY_RECOMMENDED and PROXY_NOTE.
#   caddy-new       nothing is using 80/443: install Caddy (like the native server installer)
#   caddy-existing  Caddy is already installed: add one file, never replace its config
#   nginx-existing  nginx is already installed: add one server file, never touch other sites
detect_proxy() {
  local has_caddy=0 has_nginx=0 busy="" caddy_live=0 nginx_live=0 other=""
  command -v caddy >/dev/null 2>&1 && has_caddy=1
  command -v nginx >/dev/null 2>&1 && has_nginx=1
  if command -v ss >/dev/null 2>&1; then
    busy="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
  fi
  grep -q '"caddy"' <<<"$busy" && caddy_live=1
  grep -q '"nginx"' <<<"$busy" && nginx_live=1
  other="$(grep -v -e '"caddy"' -e '"nginx"' <<<"$busy" | grep -o '"[^"]*"' | sort -u | tr -d '"' | paste -sd, - || true)"
  PROXY_OPTIONS=()
  PROXY_NOTE=""
  (( has_caddy )) && PROXY_OPTIONS+=(caddy-existing)
  (( has_nginx )) && PROXY_OPTIONS+=(nginx-existing)
  if (( ! has_caddy && ! has_nginx )); then
    if [[ -n "$other" ]]; then
      PROXY_NOTE="Port 80 or 443 is already used by: $other. The installer will not take it over; use the portable installation with your own reverse proxy."
    else
      PROXY_OPTIONS+=(caddy-new)
    fi
  fi
  PROXY_RECOMMENDED="${PROXY_OPTIONS[0]:-}"
  if (( nginx_live && ! caddy_live && has_nginx )); then PROXY_RECOMMENDED=nginx-existing; fi
}

if [[ "${1:-}" == "--detect-proxy" ]]; then
  detect_proxy
  echo "options=$(IFS=,; echo "${PROXY_OPTIONS[*]:-}")"
  echo "recommended=$PROXY_RECOMMENDED"
  echo "note=$PROXY_NOTE"
  exit 0
fi

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run this installer with sudo/root." >&2
  echo "Example: sudo ./sfu/install.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
CADDYFILE=/etc/caddy/Caddyfile
CADDY_SNIPPET=/etc/caddy/telium-sfu.caddy
die() { echo "error: $*" >&2; exit 1; }

# install.sh asks the operator and passes the answer in TELIUM_SFU_PROXY (and
# TELIUM_SFU_CADDYFILE_EDIT=yes if they agreed to the one line added to their
# Caddyfile). Run directly, ask here; with no way to ask, stop rather than guess.
PROXY="${TELIUM_SFU_PROXY:-}"
if [[ -z "$PROXY" && -f /etc/telium/sfu-proxy ]]; then
  # A rerun on a host that is already set up keeps its existing front end.
  case "$(cat /etc/telium/sfu-proxy)" in
    caddy) PROXY=caddy-existing ;;
    nginx) PROXY=nginx-existing ;;
  esac
  [[ -z "$PROXY" ]] || echo "Keeping the HTTPS front end chosen earlier: $PROXY"
fi
if [[ -z "$PROXY" ]]; then
  detect_proxy
  [[ -n "$PROXY_RECOMMENDED" ]] || die "${PROXY_NOTE:-no supported HTTPS front end found}"
  [[ -t 0 && -t 1 ]] || die "cannot ask which HTTPS front end to use without a terminal. Set TELIUM_SFU_PROXY to one of: ${PROXY_OPTIONS[*]}"
  echo "Detected HTTPS front end options: ${PROXY_OPTIONS[*]} (recommended: $PROXY_RECOMMENDED)"
  read -r -p "Use $PROXY_RECOMMENDED? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || die "cancelled; nothing was changed"
  PROXY="$PROXY_RECOMMENDED"
  if [[ "$PROXY" == caddy-existing && ! -f /etc/telium/sfu-proxy ]]; then
    read -r -p "Add 'import $CADDY_SNIPPET' to the end of your existing $CADDYFILE (a backup is saved first)? [y/N] " answer
    [[ "$answer" =~ ^[Yy] ]] && TELIUM_SFU_CADDYFILE_EDIT=yes
  fi
fi
case "$PROXY" in
  caddy-new|caddy-existing|nginx-existing) ;;
  *) die "unknown TELIUM_SFU_PROXY '$PROXY' (use caddy-new, caddy-existing or nginx-existing)" ;;
esac
echo "HTTPS front end: $PROXY"

echo "[1/7] Installing system packages..."
apt-get update -y
packages=(curl ca-certificates openssl python3 sudo tar)
# nginx and Caddy are never installed here when they are already present: the
# only extra package for nginx is Certbot's nginx plugin.
[[ "$PROXY" != nginx-existing ]] || packages+=(certbot python3-certbot-nginx)
apt-get install -y "${packages[@]}"

if ! id telium-sfu >/dev/null 2>&1; then
  useradd --system --home /var/lib/telium-sfu --create-home --shell /usr/sbin/nologin telium-sfu
fi

echo "[2/7] Locating installer files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[3/7] Downloading the telium-sfu release..."
case "$(uname -m)" in
  x86_64|amd64) sfu_arch="x86_64" ;;
  aarch64|arm64) sfu_arch="aarch64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
sfu_asset="telium-sfu-linux-${sfu_arch}.tar.gz"
sfu_base="https://github.com/telium-chat/telium/releases/download/sfu-latest"
sfu_tmp="$(mktemp -d)"
trap 'rm -rf "$sfu_tmp"' EXIT
curl -fsSL --retry 3 --max-time 900 "$sfu_base/$sfu_asset" -o "$sfu_tmp/$sfu_asset"
curl -fsSL --retry 3 --max-time 60 "$sfu_base/$sfu_asset.sha256" -o "$sfu_tmp/$sfu_asset.sha256"
( cd "$sfu_tmp" && sha256sum -c "$sfu_asset.sha256" )
tar -xzf "$sfu_tmp/$sfu_asset" -C "$sfu_tmp" telium-sfu
# This installer hands the operator over to `telium-sfu configure`; refuse a
# release that predates it rather than finish and leave them nothing to run.
"$sfu_tmp/telium-sfu" version 2>/dev/null | grep -Fxq 'management_cli=1' ||
  die "the latest published SFU release predates the command-line manager (telium-sfu status/trust/configure). Publish a new SFU release containing it, then rerun. Nothing was changed except installed packages"
install -m 0755 "$sfu_tmp/telium-sfu" /usr/local/bin/telium-sfu
rm -rf "$sfu_tmp"; trap - EXIT

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

echo "[5/7] Installing the proxy helper and service..."
# Root-only: `telium-sfu configure` calls it (through sudo) to write the Caddy or
# nginx site and get certificates. The service account no longer needs, or
# gets, any way to run it: earlier versions let the web dashboard do that.
install -d -m 0755 /usr/local/libexec
install -m 0755 "$SCRIPT_DIR/scripts/admin-helper.sh" /usr/local/libexec/telium-sfu-admin-helper
rm -f /etc/sudoers.d/telium-sfu

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

# Limits for public SFU operators. Zero means UNLIMITED, not disabled.
# Set transfer_budget_bytes to your VPS allowance (BYTES, not GB).
# New rooms stop at 80% by default; existing calls finish naturally.
# This is an estimate, not your provider's actual traffic meter.
[limits]
max_bitrate = 10000000
enforce = true
poll_interval_secs = 15
max_rooms = 0
max_participants = 0
transfer_budget_bytes = 0
transfer_period_days = 30
transfer_stop_percent = 80

[install]
mode = "full"
sfu_domain = ""
EOF
  chown telium-sfu:telium-sfu "$CONFIG"
  chmod 0640 "$CONFIG"
fi

# LiveKit credentials must survive SFU restarts. Older installer builds left
# these empty, causing telium-sfu to generate a new pair every boot. If an old
# livekit-server survived a restart, its old key no longer matched newly minted
# client tokens and LiveKit reported "invalid API key".
if grep -q '^api_key = ""' "$CONFIG"; then
  lk_key="telium$(openssl rand -hex 8)"
  lk_secret="$(openssl rand -hex 32)"
  sed -i "s|^api_key = .*|api_key = \"$lk_key\"|" "$CONFIG"
  sed -i "s|^api_secret = .*|api_secret = \"$lk_secret\"|" "$CONFIG"
  chown telium-sfu:telium-sfu "$CONFIG"
  echo "generated LiveKit API credentials into $CONFIG"
fi

cat > /etc/systemd/system/telium-sfu.service <<'EOF'
[Unit]
Description=Telium SFU
After=network-online.target
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

# --- HTTPS front end -------------------------------------------------------
# Nothing here removes or replaces an existing proxy's configuration.
# `telium-sfu configure` adds the real domains later (sfu/scripts/admin-helper.sh).
install -d -m 0755 /etc/telium
case "$PROXY" in
  caddy-new|caddy-existing)
    if [[ "$PROXY" == caddy-new ]] && ! command -v caddy >/dev/null 2>&1; then
      echo "Installing Caddy (apt-get install caddy)..."
      apt-get install -y caddy || die "could not install Caddy; install it yourself (https://caddyserver.com/docs/install) and rerun"
    fi
    systemctl cat caddy.service >/dev/null 2>&1 ||
      die "Caddy is installed but has no caddy.service. Add 'import $CADDY_SNIPPET' to your Caddyfile yourself, then rerun"
    install -d -m 0755 /etc/caddy
    [[ -e "$CADDY_SNIPPET" ]] ||
      printf '# Written by Telium SFU setup. `telium-sfu configure` adds your SFU and LiveKit sites here.\n' > "$CADDY_SNIPPET"
    import_line="import $CADDY_SNIPPET"
    if ! grep -qxF "$import_line" "$CADDYFILE" 2>/dev/null; then
      if [[ ! -s "$CADDYFILE" ]] || grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$CADDYFILE"; then
        printf '# Written by Telium SFU setup.\n{\n\tadmin 127.0.0.1:2019\n}\n%s\n' "$import_line" > "$CADDYFILE"
      else
        [[ "${TELIUM_SFU_CADDYFILE_EDIT:-}" == yes ]] ||
          die "your $CADDYFILE has its own settings and you did not agree to change it, so it was left untouched. Add this line to it yourself, then rerun: $import_line"
        cp -p "$CADDYFILE" "$CADDYFILE.telium-sfu.bak"
        printf '\n%s\n' "$import_line" >> "$CADDYFILE"
        if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
          cp -p "$CADDYFILE.telium-sfu.bak" "$CADDYFILE"
          die "Caddy rejected the configuration, so $CADDYFILE was restored from its backup (nothing changed)"
        fi
        echo "Added '$import_line' to $CADDYFILE (backup: $CADDYFILE.telium-sfu.bak)"
      fi
    fi
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 ||
      die "Caddy rejected its configuration; see: caddy validate --config $CADDYFILE --adapter caddyfile"
    systemctl enable --now caddy
    systemctl reload caddy || systemctl restart caddy
    echo caddy > /etc/telium/sfu-proxy
    ;;
  nginx-existing)
    nginx -t >/dev/null 2>&1 || echo "warning: 'nginx -t' reports a problem with your existing nginx configuration; fix it before configuring domains"
    echo nginx > /etc/telium/sfu-proxy
    ;;
esac

systemctl daemon-reload
systemctl enable telium-sfu
systemctl restart telium-sfu

# The self-updater: check the signed release feed on a timer, drain live
# calls, swap the binary. Without it this install updates only by being run
# again, and a relay whose operators rebuild by hand is a relay that stays on
# the release it started with. The conf is installed only when absent, so a
# re-run never clobbers an operator's pin or window.
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/deploy"
if [[ -f "$DEPLOY_DIR/update-sfu-native.sh" ]]; then
  install -d -m 0755 /etc/telium /usr/local/sbin
  install -m 0755 "$DEPLOY_DIR/update-sfu-native.sh" /usr/local/sbin/telium-update-sfu-native
  [[ -f /etc/telium/update-sfu.conf ]] || install -m 0644 "$DEPLOY_DIR/update-sfu.conf" /etc/telium/update-sfu.conf
  install -m 0644 "$DEPLOY_DIR/telium-sfu-update-native.service" /etc/systemd/system/telium-sfu-update-native.service
  install -m 0644 "$DEPLOY_DIR/telium-sfu-update-native.timer" /etc/systemd/system/telium-sfu-update-native.timer
  systemctl daemon-reload
  systemctl enable --now telium-sfu-update-native.timer
  echo "Self-updates enabled (telium-sfu-update-native.timer); mode and pin live in /etc/telium/update-sfu.conf"
fi

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
if [[ "${TELIUM_SFU_FROM_INSTALLER:-}" != 1 ]]; then
  echo
  echo "=============================================================="
  echo "Telium SFU is installed."
  echo
  echo "Next, set its domains and who may use it (this also sets up HTTPS"
  echo "through $PROXY):"
  echo "  sudo telium-sfu configure"
  echo
  echo "Afterwards:  telium-sfu status | telium-sfu trust add <server> | telium-sfu manage"
  echo "=============================================================="
fi
