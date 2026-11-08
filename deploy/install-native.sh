#!/usr/bin/env bash
#
# Put a Telium homeserver on this box as one static binary under systemd, and
# leave it updating itself.
#
# This is the native path's counterpart to install.sh, and it exists for the
# same reason that file exists: a documented sequence of nine commands gets
# skimmed, and the step that gets skipped is always the one at the bottom.
# Here the sequence is one command with the domain as its argument:
#
#   sudo ./deploy/install-native.sh chat.example.com
#
# Everything the box needs is derived from that one piece of information a
# human actually has. The config is written, not seeded-and-explained; the
# binary is downloaded from the rolling `server-latest` release and checked
# against the sha256 the release publishes; the updater and its timer go on
# with updates enabled, because a default that has to be turned on by a
# command nobody runs is not a default.
#
# DNS and TLS are completed outside the installer. Registration uses the
# centralized official client, and administrative access is granted locally.
#
# Safe to run twice. What is ours -- the binary, the units, the updater --
# is replaced every time, which is how this machinery upgrades. What is
# theirs -- telium.toml, update.conf, and everything under the data and
# backup directories -- is created once and never touched again.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=telium-chat/telium
ROLLING=server-latest

BIN=/usr/local/bin/telium-server
UPDATE_BIN=/usr/local/sbin/telium-update-native
ETC=/etc/telium
CONF=$ETC/telium.toml
EXAMPLE=$ETC/telium.example.toml
UPD_CONF=$ETC/update.conf
DATA=/var/lib/telium
BACKUPS=/var/backups/telium

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the domain

# The domain is the one input, and it is worth being strict about: it becomes
# the half of every account id this server ever mints, and the check tool
# would refuse it at startup anyway -- better here, before anything is
# written, than at ExecStartPre afterwards.
[ $# -eq 1 ] || { echo "usage: sudo $0 <domain>   e.g. sudo $0 chat.example.com" >&2; exit 2; }

DOMAIN="${1#*://}"          # tolerate a pasted URL
DOMAIN="${DOMAIN%%/*}"      # drop any path
DOMAIN="${DOMAIN%.}"        # drop a trailing dot
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*) die "'$DOMAIN' does not look like a domain name" ;;
esac
case "$DOMAIN" in
  *.*) : ;;
  *) die "refusing a dotless name ($DOMAIN); the startup audit would call it a danger" ;;
esac
case "$DOMAIN" in
  localhost|localhost.*|example.com|example.org|example.net|change.me)
    die "refusing '$DOMAIN'; it is a placeholder, not a home" ;;
esac

# ------------------------------------------------------------------ the host

# Root is needed for /usr/local, /etc/systemd and the telium user. Unlike the
# container path there is no registry credential tied to an account, so no
# ordinary user has to own anything afterwards -- but running this as a login
# root shell is still worth a word, not a refusal.
[ "$(id -u)" -eq 0 ] || die "run this with sudo -- it writes to /usr/local, /etc and /var"

command -v curl      >/dev/null 2>&1 || die "curl is not installed"
command -v tar       >/dev/null 2>&1 || die "tar is not installed"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is not installed"
command -v systemctl >/dev/null 2>&1 || die "this box does not use systemd; there is no native path without it"
command -v runuser   >/dev/null 2>&1 || die "runuser is required to audit the config as the service user"

machine="$(uname -m)"
case "$machine" in
  x86_64)  ARCH=x86_64 ;;
  aarch64) ARCH=aarch64 ;;
  *) die "$machine is not an architecture releases are published for (x86_64, aarch64)" ;;
esac

# A rerun must not replace the binary of an active service. Upgrades (including
# database migrations) belong to update-native.sh, which takes a backup before
# changing the executable and restarts the service in a controlled way.
existing_install=0
if [ -e "$BIN" ]; then
  [ -x "$BIN" ] || die "$BIN exists but is not executable; refusing to overwrite it"
  [ -f "$CONF" ] || die "$BIN exists but $CONF does not; restore the original config before attempting an upgrade"
  existing_install=1
fi

step "Installing for chat on $DOMAIN ($machine)"

# ---------------------------------------------------------------- the binary
#
# The rolling release is the address for new installs -- the same one the
# updater will follow from its first tick. The sha256 comes from the same
# release over TLS, which makes this check about transport mistakes rather
# than about a motivated attacker; the stronger chain (the signed manifest,
# verified in the binary) takes over from the updater's first run, and every
# run after that.

if [ "$existing_install" -eq 1 ]; then
  step "Existing server"
  say "keeping the installed binary; the signed updater handles backups and restarts"
else
  step "Downloading the server"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://github.com/$REPO/releases/download/$ROLLING"
  asset="telium-server-linux-$ARCH.tar.gz"

  curl -fsSL --connect-timeout 15 --max-time 900 -o "$tmp/$asset" "$base/$asset" \
    || die "the download from $base failed"
  curl -fsSL --connect-timeout 15 --max-time 60 -o "$tmp/SHA256SUMS-server" "$base/SHA256SUMS-server" \
    || die "could not fetch the SHA256SUMS the release publishes"

  grep "  $asset\$" "$tmp/SHA256SUMS-server" | (cd "$tmp" && sha256sum --check --quiet -) \
    || die "the downloaded archive does not match the sha256 the release published; it is deleted"
  tar -xzf "$tmp/$asset" -C "$tmp" telium-server telium.example.toml \
    || die "the downloaded archive is not the archive it claimed to be"

  commit="$("$tmp/telium-server" version 2>/dev/null | sed -n 's/^commit=//p')"
  [ -n "$commit" ] || die "the downloaded binary does not run here, or does not name a commit"

  # Fail before modifying the machine if the released binary is too old to
  # support private registration, which is part of this installer's contract.
  "$tmp/telium-server" registration-code --help >/dev/null 2>&1 \
    || die "the latest published server binary does not support registration codes yet; wait for a compatible release"

  install -Dm755 "$tmp/telium-server" "$BIN"
  install -Dm644 "$tmp/telium.example.toml" "$EXAMPLE"
  say "$BIN is release ${commit:0:12}; the annotated config is at $EXAMPLE"
fi

# ------------------------------------------------------------ user and paths

step "User and directories"

id telium >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin telium
install -d -o telium -g telium -m 750 "$DATA"
install -d -o telium -g telium -m 700 "$BACKUPS"
install -d -m 755 "$ETC"

# Run every CLI command from systemd's WorkingDirectory. Otherwise relative
# secret paths (notably mfa.key) resolve against the installer's current
# directory, which may be root-owned and unwritable by the service account.
as_telium() (
  cd "$DATA"
  # Normal daemon logging is unchanged; setup CLIs only need warnings/errors.
  RUST_LOG="${RUST_LOG:-warn}" runuser -u telium -- "$BIN" --config "$CONF" "$@"
)

# --------------------------------------------------------------- the config
#
# Preserve all existing configuration on reruns. The one exception is
# installer-generated configs missing [registration] from older releases:
# they receive an appended safe registration section after the operator chooses.

step "Configuration"

if [ -e "$CONF" ]; then
  say "$CONF already exists; left alone"
else
  install -o telium -g telium -m 600 /dev/null "$CONF"
  cat > "$CONF" <<EOF
# Written by deploy/install-native.sh for $DOMAIN. Every setting not listed
# here keeps its compiled-in default; $EXAMPLE annotates all of them.

# Identity, not a hostname: this is the half of a user id after the colon,
# and it is baked into every id and signature this server ever mints.
server_name = "$DOMAIN"

# Where clients and other servers reach us, published at
# /.well-known/telium/server. Requires the TLS that goes in front of us.
public_base_url = "https://$DOMAIN"

# Loopback only: the reverse proxy or tunnel in front of us is the public side.
bind = "127.0.0.1:8448"

database_url = "sqlite://$DATA/telium.db?mode=rwc"
media_dir = "$DATA/media"

[rate_limit]
# The proxy's address, so rate limits apply to real clients and not to it.
trusted_proxies = ["127.0.0.1"]

[backup]
# Archives outside the data directory, and the key beside them: the key is
# the whole of the restore, so it wants copying off this machine the day the
# server logs that it minted one.
dir = "$BACKUPS/archives"
key_file = "$BACKUPS/backup.key"

[mfa]
# An absolute path also works for ad-hoc CLI commands run outside the
# systemd working directory. Keep this key separate from database backups.
key_file = "$DATA/mfa.key"
EOF
  say "$CONF written for $DOMAIN"
fi

# --------------------------------------------------------- registration setup
#
# The native server does not give the first signup administrator privileges.
# Existing operator-specified [registration] settings are never overwritten.
if ! grep -qE '^[[:space:]]*\[registration\][[:space:]]*(#.*)?$' "$CONF"; then
  if ! grep -Fq "# Written by deploy/install-native.sh for " "$CONF"; then
    die "$CONF is not an installer-generated config; configure [registration] before continuing"
  fi
  registration="${TELIUM_REGISTRATION:-}"
  if [ -z "$registration" ] && [ -t 0 ]; then
    printf '\nAllow anyone to create an account on this server? [Y/n] '
    read -r answer || die "could not read the registration choice"
    case "$answer" in
      ""|y|Y|yes|YES) registration=open ;;
      n|N|no|NO) registration=closed ;;
      *) die "choose yes or no" ;;
    esac
  fi
  registration="${registration:-open}"
  case "$registration" in
    open) registration_bool=true ;;
    closed) registration_bool=false ;;
    *) die "TELIUM_REGISTRATION must be open or closed" ;;
  esac
  cat >> "$CONF" <<EOF

[registration]
# New accounts never become server administrators simply by registering.
# Grant the operator's account admin locally after signing up.
first_account_is_admin = false
open = $registration_bool
admins = []
EOF
  if [ "$registration" = closed ]; then
    say "registration PRIVATE: only people with a valid registration code can sign up"
  else
    say "registration OPEN: anyone can sign up, but no signup automatically becomes admin"
  fi
else
  say "existing [registration] policy retained"
fi

# ----------------------------------------------------------------- the units

step "systemd"

install -Dm755 "$here/update-native.sh" "$UPDATE_BIN"
install -Dm644 "$here/telium-server.service"          /etc/systemd/system/telium-server.service
install -Dm644 "$here/telium-update-native.service"   /etc/systemd/system/telium-update-native.service
install -Dm644 "$here/telium-update-native.timer"     /etc/systemd/system/telium-update-native.timer

if [ -e "$UPD_CONF" ]; then
  say "$UPD_CONF already exists; left alone"
else
  cat > "$UPD_CONF" <<'EOF'
# Read by telium-update-native on every tick. Delete a line to fall back to
# its default, which is the empty value shown.
TELIUM_UPDATES=automatic
# TELIUM_PIN=            a commit to hold; empty follows the channel
# TELIUM_PIN_REASON=     why a pin is there; a pin without a reason is reported on every run
# TELIUM_UPDATE_WINDOW=  HH:MM-HH:MM; empty means any time
# TELIUM_ARTIFACT=       server-linux-x86_64 or server-linux-aarch64; empty follows this CPU
EOF
  say "$UPD_CONF written: updates are ON"
fi

systemctl daemon-reload
say "units installed"

# ------------------------------------------------------------------- check
#
# The same audit the unit runs at every start, here with the new binary
# against the new config -- so a finding is a person reading a line now
# instead of a unit that refuses to start in five minutes.

step "Checking the configuration"

# Installation requires root, but the service itself runs as User=telium.
# Validate under that actual identity. Show actionable warnings, not default notices.
# A newly checked-out installer may be newer than the published release.
# Older binaries accept `check` but not the new `--installation` presentation.
if "$BIN" check --help 2>/dev/null | grep -q -- '--installation'; then
  check_args=(check --installation)
else
  check_args=(check)
fi
if ! as_telium "${check_args[@]}"; then
  echo "error: the configuration did not pass as the telium service user; check $CONF and rerun $0 $DOMAIN" >&2
  exit 1
fi

# ------------------------------------------------------------------- start

step "Starting"

systemctl enable --now telium-server.service telium-update-native.timer
say "telium-server.service and telium-update-native.timer are enabled"

if [ "$existing_install" -eq 1 ]; then
  # The updater uses the signed release manifest, takes a verified local
  # backup, swaps atomically and restarts. Without --now it respects breaking
  # release holds, update windows and operator-selected manual mode.
  # It may stage an update rather than install one; that is intentional.
  step "Checking for server updates"
  "$UPDATE_BIN" || die "native updater failed; inspect its output and journalctl -u telium-server before retrying"
fi

# The server binds loopback, so its own health endpoint answers as soon as
# the process is up, whatever DNS and TLS are doing.
ok=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 http://127.0.0.1:8448/_telium/v1/health >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 1
done
[ -n "$ok" ] || die "the health endpoint on 127.0.0.1:8448 did not answer; look at: journalctl -u telium-server -n 50"
say "the server is up on 127.0.0.1:8448"

# ------------------------------------------------------ private registration
# The database exists now and is owned by telium, not root. The bootstrap
# code is minted once, shown once, and never stored in plaintext.
step "Registration"
# Capture the CLI's own effective-policy result instead of guessing from
# a hand-parsed TOML boolean. The code is still shown only once to stdout.
registration_result="$(as_telium registration-code bootstrap)" \
  || die "could not create the setup registration code"
printf '%s\n' "$registration_result"
case "$registration_result" in
  "registration is public;"*) registration_state=open ;;
  "Initial private registration code"*) registration_state=new_private ;;
  "the initial code was already created"*) registration_state=existing_private ;;
  *) die "unexpected response from registration-code bootstrap; check the server version" ;;
esac

# ------------------------------------------------------------ what is left
#
# DNS and TLS need external setup; the centralized client handles account
# creation. Only a person with local machine access can grant server admin.

if [ "$existing_install" -eq 1 ]; then
  step "Existing server checked"
  say "existing configuration and administrator access were preserved"
  say "public discovery: curl -fsS https://$DOMAIN/.well-known/telium/server"
  say "web client: https://telium.chat"
  if [ "$registration_state" = existing_private ]; then
    say "Enter your saved private registration code to add an account."
    say "If lost or expired, mint a replacement on the server:"
    say "  ( cd $DATA && runuser -u telium -- $BIN --config $CONF registration-code create )"
  elif [ "$registration_state" = open ]; then
    say "Registration remains open; no invitation code is required."
  else
    say "Save the initial private registration code printed above."
  fi
else
  step "Still to do, by hand"

  say "1. point DNS: $DOMAIN -> this box's public address"
say "2. put TLS in front, one of:"
say "     a Cloudflare Tunnel (no open ports):  docs.telium.chat/self-hosting/exposing/"
say "     or Caddy on this box (real certificates): docs.telium.chat/self-hosting/exposing/"
say "   then verify:"
say "     curl -fsS https://$DOMAIN/.well-known/telium/server"
say "3. open https://telium.chat to register your account on this server."
case "$registration_state" in
  new_private)
    say "   Enter the one-time registration code shown above; save it securely."
    ;;
  existing_private)
    say "   Enter your saved private registration code."
    say "   If it was lost or expired, generate another on this machine:"
    say "     ( cd $DATA && runuser -u telium -- $BIN --config $CONF registration-code create )"
    ;;
  open)
    say "   Registration is open; no invitation code is required."
    ;;
esac
say "4. grant the account administrator access, here on the server:"
say "     ( cd $DATA && runuser -u telium -- $BIN --config $CONF admin recover USERNAME --reason \"Initial server owner\" )"
say "   Replace USERNAME with the account localpart (or full @name:domain)."
say "   Confirm the username; the holder of that account must still sign in."
if [ "$registration_state" != open ]; then
  say "   Further registration codes: Control plane > Registration codes."
fi
say "   To change signup later, edit [registration].open in $CONF"
say "   and restart telium-server."
say ""
  say "voice uses the signed public SFU directory by default; hosting your own"
  say "voice relay is optional: docs.telium.chat/self-hosting/sfu/"
fi
