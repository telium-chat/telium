#!/usr/bin/env bash
# Interactive installer for a native Telium SFU relay.
#
#   sudo bash sfu/install.sh
#
# It asks how this machine should host the relay, says what that will change,
# waits for a yes, installs, and then hands over to `telium-sfu configure` to
# set the domains and HTTPS. Afterwards the same `telium-sfu` command shows
# status and manages the whitelist (`telium-sfu --help`).
#
# Everything it asks can be given as a flag, so it also runs unattended:
#
#   sudo bash sfu/install.sh --mode portable --dir /opt/telium-sfu --yes \
#     --sfu-domain sfu.example.com --livekit-domain livekit.example.com \
#     --private --homeserver chat.example.com
#
# --dry-run prints what would happen and changes nothing (no root needed).
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo bash sfu/install.sh [options]

Installation
  --mode full|portable     full: Telium manages Caddy/nginx and HTTPS (Ubuntu/Debian).
                           portable: one folder, your own reverse proxy.
  --proxy KIND             full mode only: caddy-new, caddy-existing or nginx-existing.
  --dir PATH               portable mode only: install under PATH (/opt/... or /srv/...).
  --caddyfile-edit         allow adding one `import` line to an existing Caddyfile
                           (backup and rollback included).
  --yes, -y                do not ask for confirmation.
  --dry-run                show the plan; change nothing.

Setup after installing (passed to `telium-sfu configure`)
  --sfu-domain NAME        public hostname of the SFU API
  --livekit-domain NAME    public hostname for LiveKit signalling
  --email ADDRESS          Let's Encrypt contact (full mode)
  --public | --private     who may use the relay
  --homeserver NAME        your Telium homeserver (trusted automatically)
  --no-configure           install only; run `telium-sfu configure` yourself later.
USAGE
}

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have_tty() { [[ -t 0 && -t 1 ]]; }

MODE="" PROXY="" DIR="" CADDY_EDIT=no ASSUME_YES=0 DRY_RUN=0 NO_CONFIGURE=0 SRC_ROOT=""
CONF_ARGS=()
need_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) need_value "$@"; MODE="$2"; shift 2 ;;
    --proxy) need_value "$@"; PROXY="$2"; shift 2 ;;
    --dir) need_value "$@"; DIR="$2"; shift 2 ;;
    --caddyfile-edit) CADDY_EDIT=yes; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-configure) NO_CONFIGURE=1; shift ;;
    --source-root) need_value "$@"; SRC_ROOT="$2"; shift 2 ;;
    --sfu-domain|--livekit-domain|--email|--homeserver) need_value "$@"; CONF_ARGS+=("$1" "$2"); shift 2 ;;
    --public|--private) CONF_ARGS+=("$1"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
case "$MODE" in ""|full|portable) ;; *) die "--mode must be full or portable" ;; esac

ask() { # ask "question" "default" -> $REPLY
  local answer
  if [[ -n "${2:-}" ]]; then read -r -p "$1 [$2]: " answer; else read -r -p "$1: " answer; fi
  REPLY="${answer:-${2:-}}"
}
confirm() { # confirm "question" default(y|n)
  local answer hint="[y/N]"
  [[ "${2:-n}" == y ]] && hint="[Y/n]"
  while true; do
    read -r -p "$1 $hint " answer
    case "${answer,,}" in
      "") [[ "${2:-n}" == y ]]; return ;;
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) say "Please answer y or n." ;;
    esac
  done
}

# The same rule install-portable.sh enforces (it checks again; this just lets
# the question be asked again instead of the install failing after the answer).
valid_dir() {
  [[ "$1" =~ ^/(opt|srv)/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$1" != *"/../"* && "$1" != *"/./"* && "$1" != *"//"* && "$1" != *"/.." && "$1" != *"/." ]] || return 1
  [[ "$1" != /opt && "$1" != /srv && "$1" != */ ]] || return 1
  local c="$1"
  while [[ "$c" != "/" ]]; do
    [[ ! -L "$c" ]] || return 1
    c="$(dirname "$c")"
  done
}

if [[ ${EUID} -ne 0 && $DRY_RUN -eq 0 ]]; then
  die "run with sudo/root: sudo bash sfu/install.sh"
fi
command -v systemctl >/dev/null 2>&1 || [[ $DRY_RUN -eq 1 ]] || die "this installer needs a Linux machine that uses systemd"

# --- installer files --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$SRC_ROOT" ]]; then
  :
elif [[ -f "$SCRIPT_DIR/Cargo.toml" && -f "$SCRIPT_DIR/../telium-protocol/Cargo.toml" ]]; then
  SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "missing $tool; install it and rerun"
  done
  TMP_SRC="$(mktemp -d)"
  trap 'rm -rf "$TMP_SRC"' EXIT
  REPO="${TELIUM_REPO:-telium-chat/telium}" REF="${TELIUM_REF:-main}"
  [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ && "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid TELIUM_REPO or TELIUM_REF"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" -o "$TMP_SRC/telium.tar.gz"
  tar xzf "$TMP_SRC/telium.tar.gz" -C "$TMP_SRC"
  SRC_ROOT="$(find "$TMP_SRC" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi
[[ -f "$SRC_ROOT/sfu/install-full.sh" && -f "$SRC_ROOT/sfu/install-portable.sh" ]] || die "installer files not found under $SRC_ROOT"

# What is installed here already: a rerun keeps the earlier choices.
EXISTING_PROXY=""
[[ -f /etc/telium/sfu-proxy ]] && EXISTING_PROXY="$(cat /etc/telium/sfu-proxy)"

# --- what this machine can do ----------------------------------------------
PROXY_OPTIONS=() PROXY_RECOMMENDED="" PROXY_NOTE=""
if command -v apt-get >/dev/null 2>&1; then
  while IFS= read -r line; do
    case "$line" in
      options=*) IFS=, read -r -a PROXY_OPTIONS <<<"${line#options=}" ;;
      recommended=*) PROXY_RECOMMENDED="${line#recommended=}" ;;
      note=*) PROXY_NOTE="${line#note=}" ;;
    esac
  done < <(bash "$SRC_ROOT/sfu/install-full.sh" --detect-proxy 2>/dev/null || true)
else
  PROXY_NOTE="Full installation needs apt (Ubuntu or Debian)."
fi
FULL_OK=0
[[ ${#PROXY_OPTIONS[@]} -gt 0 ]] && FULL_OK=1

say
say "Telium SFU installer"
say "Nothing on this machine changes until you confirm below."
say

# --- mode -------------------------------------------------------------------
if [[ -z "$MODE" ]]; then
  have_tty || die "no terminal to ask on; pass --mode full or --mode portable"
  say "How should this machine host the SFU?"
  say
  if (( FULL_OK )); then
    say "  1) Full  (recommended for a VPS)"
    say "     Telium manages the HTTPS front end: it adds its two sites to your Caddy or"
    say "     nginx (installing Caddy only if neither is present), gets certificates, and"
    say "     opens firewall ports where UFW is active. Installs packages, a service"
    say "     account and systemd units, and keeps itself updated. Existing proxy"
    say "     configuration is never deleted or replaced."
  else
    say "  1) Full  -- not available here: ${PROXY_NOTE:-no supported HTTPS front end was found.}"
  fi
  say
  say "  2) Portable  (a shared machine, or one that already runs your own proxy)"
  say "     Everything lives in one folder you choose under /opt or /srv. Uses your existing"
  say "     reverse proxy and firewall and does not touch them, nor packages. Outside the"
  say "     folder: a service account and three systemd units. Also self-updating."
  say
  default=2; (( FULL_OK )) && default=1
  while true; do
    ask "Choose" "$default"
    case "$REPLY" in
      1) if (( FULL_OK )); then MODE=full; break; else say "Full installation is not available on this machine."; fi ;;
      2) MODE=portable; break ;;
      *) say "Type 1 or 2." ;;
    esac
  done
fi

# --- mode specifics ---------------------------------------------------------
if [[ "$MODE" == full ]]; then
  [[ -z "$DIR" ]] || die "--dir is for portable mode"
  if [[ -n "$EXISTING_PROXY" ]]; then
    case "$EXISTING_PROXY" in caddy) PROXY=caddy-existing ;; nginx) PROXY=nginx-existing ;; esac
    say "Keeping the HTTPS front end chosen earlier: $PROXY"
  fi
  if [[ -z "$PROXY" ]]; then
    (( FULL_OK )) || die "${PROXY_NOTE:-no supported HTTPS front end found}. Use --mode portable with your own reverse proxy"
    if [[ ${#PROXY_OPTIONS[@]} -eq 1 ]]; then
      PROXY="${PROXY_OPTIONS[0]}"
    elif ! have_tty; then
      die "several HTTPS front ends are possible (${PROXY_OPTIONS[*]}); pass --proxy"
    else
      say
      say "Which HTTPS front end should Telium use?"
      i=1
      for option in "${PROXY_OPTIONS[@]}"; do
        case "$option" in
          caddy-new) text="Install Caddy (nothing is using ports 80/443; Caddy gets certificates itself)" ;;
          caddy-existing) text="Your existing Caddy (it stays as is; Telium adds /etc/caddy/telium-sfu.caddy)" ;;
          nginx-existing) text="Your existing nginx (no default site is removed; Telium adds one server file and Certbot's nginx plugin for its two names)" ;;
          *) text="$option" ;;
        esac
        mark=""; [[ "$option" == "$PROXY_RECOMMENDED" ]] && mark=" (recommended)"
        say "  $i) $text$mark"
        i=$((i + 1))
      done
      while true; do
        rec_index=1; i=1
        for option in "${PROXY_OPTIONS[@]}"; do [[ "$option" == "$PROXY_RECOMMENDED" ]] && rec_index=$i; i=$((i + 1)); done
        ask "Choose" "$rec_index"
        if [[ "$REPLY" =~ ^[0-9]+$ ]] && (( REPLY >= 1 && REPLY <= ${#PROXY_OPTIONS[@]} )); then
          PROXY="${PROXY_OPTIONS[$((REPLY - 1))]}"; break
        fi
        say "Type a number from the list."
      done
    fi
  fi
  case "$PROXY" in
    caddy-new|caddy-existing|nginx-existing) ;;
    *) die "unknown proxy '$PROXY' (use caddy-new, caddy-existing or nginx-existing)" ;;
  esac
  if [[ -z "$EXISTING_PROXY" ]]; then
    ok=0; for option in "${PROXY_OPTIONS[@]}"; do [[ "$option" == "$PROXY" ]] && ok=1; done
    (( ok )) || die "$PROXY is not available on this machine (available: ${PROXY_OPTIONS[*]:-none}; ${PROXY_NOTE:-})"
  fi
  # An existing Caddyfile is only edited with explicit consent.
  IMPORT_LINE="import /etc/caddy/telium-sfu.caddy"
  if [[ "$PROXY" == caddy-existing && -z "$EXISTING_PROXY" && "$CADDY_EDIT" != yes ]] \
      && ! grep -qxF "$IMPORT_LINE" /etc/caddy/Caddyfile 2>/dev/null; then
    if have_tty && (( ! ASSUME_YES )); then
      say
      say "Your Caddy keeps its own settings in /etc/caddy/Caddyfile. Telium needs one line there:"
      say "  $IMPORT_LINE"
      confirm "Add it for you (a backup is saved first, and it is rolled back if Caddy rejects it)?" n && CADDY_EDIT=yes
    fi
    if [[ "$CADDY_EDIT" != yes ]]; then
      say
      say "To use your existing Caddy, add this line to the end of /etc/caddy/Caddyfile yourself, or rerun and allow it (--caddyfile-edit):"
      say "  $IMPORT_LINE"
      [[ $DRY_RUN -eq 1 ]] || exit 1
    fi
  fi
else
  [[ -z "$PROXY" ]] || die "--proxy is for full mode"
  if [[ -z "$DIR" ]]; then
    if have_tty && (( ! ASSUME_YES )); then
      say
      say "Where should the relay live? Use a dedicated path under /opt or /srv that contains no symlinks."
      while true; do
        ask "Installation directory" "/opt/telium-sfu"
        if valid_dir "$REPLY"; then DIR="${REPLY%/}"; break; fi
        say "That path will not do: choose a dedicated absolute directory under /opt or /srv, without . or .. or symlinks."
      done
    else
      DIR=/opt/telium-sfu
    fi
  fi
  valid_dir "$DIR" || die "--dir must be a dedicated absolute path under /opt or /srv, without . or .. components or symlinks"
  DIR="${DIR%/}"
fi

# --- plan -------------------------------------------------------------------
if [[ "$MODE" == full ]]; then
  SCRIPT="$SRC_ROOT/sfu/install-full.sh"; ARGS=()
  BIN=/usr/local/bin/telium-sfu; CONFIG=/var/lib/telium-sfu/sfu.toml
else
  SCRIPT="$SRC_ROOT/sfu/install-portable.sh"; ARGS=("$DIR")
  BIN="$DIR/bin/telium-sfu"; CONFIG="$DIR/config/sfu.toml"
fi
say
say "This will install a $MODE relay:"
if [[ "$MODE" == full ]]; then
  say "  - system packages (curl, openssl, python3, sudo, tar, and Certbot for nginx)"
  say "  - the telium-sfu and livekit-server binaries in /usr/local/bin"
  say "  - the service account 'telium-sfu', its data in /var/lib/telium-sfu, and systemd units"
  say "  - HTTPS front end: $PROXY"
  say "  - UFW rules for 80, 443, 7881/tcp, 3478/udp, 50000-60000/udp, if UFW is active"
  say "  - the automatic updater (a systemd timer)"
else
  say "  - everything under $DIR (binaries, config, data, updater)"
  say "  - the service account 'telium-sfu' and three systemd units"
  say "  - no packages, proxy, certificate or firewall changes"
fi
say
if (( DRY_RUN )); then
  say "Dry run: would run: bash $SCRIPT ${ARGS[*]:-}"
  say "Dry run: then hand over to: $BIN --config $CONFIG configure ${CONF_ARGS[*]:-}"
  exit 0
fi
if (( ! ASSUME_YES )); then
  have_tty || die "no terminal to confirm on; pass --yes to proceed"
  confirm "Install now?" y || { say "Nothing was changed."; exit 0; }
fi

# --- install ----------------------------------------------------------------
say
env TELIUM_SFU_PROXY="$PROXY" TELIUM_SFU_CADDYFILE_EDIT="$CADDY_EDIT" TELIUM_SFU_FROM_INSTALLER=1 \
  bash "$SCRIPT" "${ARGS[@]}" || die "installation failed (see above). You can rerun this installer once the problem is fixed"

# --- hand over --------------------------------------------------------------
say
say "Installed."
if grep -q '^public_url = "https://' "$CONFIG" 2>/dev/null && [[ ${#CONF_ARGS[@]} -eq 0 ]]; then
  say "This relay was already configured; its domains and settings were kept."
elif (( NO_CONFIGURE )); then
  say "Next: $BIN configure"
elif [[ ${#CONF_ARGS[@]} -gt 0 ]]; then
  "$BIN" --config "$CONFIG" configure --yes "${CONF_ARGS[@]}"
elif have_tty; then
  say
  say "Next the relay needs its domains, and a choice of who may use it."
  if confirm "Set that up now?" y; then
    "$BIN" --config "$CONFIG" configure
  else
    say "Whenever you are ready: sudo $BIN configure"
  fi
else
  say "Next: sudo $BIN configure"
fi
say
say "Manage it from here on with:"
say "  $BIN status          what the relay is doing"
say "  $BIN trust add NAME  whitelist a Telium server"
say "  $BIN manage          interactive menu"
say "  $BIN --help          everything else"
