#!/usr/bin/env bash
# Run ONLY in an isolated disposable container as root. Mocks releases and
# systemctl, but exercises the real install and updater shell scripts.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "requires container root" >&2; exit 1; }
command -v runuser >/dev/null
command -v flock >/dev/null

work="$(mktemp -d)"
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    for log in "$work"/*.log; do
      [ -f "$log" ] || continue
      echo "--- $(basename "$log") (last 100 lines) ---" >&2
      tail -n 100 "$log" >&2
    done
  fi
  rm -rf "$work"
}
trap cleanup EXIT
export MOCK_WORK="$work"
export MOCK_STAGE=1
mkdir -p "$work/bin" "$work/state" "$work/releases"
# The real service user exercises these binaries; let it traverse the fixture
# root and record mock CLI calls. Production secrets remain inside /var/lib.
chmod 755 "$work"
chmod 777 "$work/state"

# Mock only the things not provided by the container: the release CDN and
# systemd itself. Real runuser, file permissions, shell tools and installer
# files still run against the container's isolated filesystem.
cat > "$work/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail
url="${*: -1}"
out=""
for ((n=1; n<=$#; n++)); do
  if [ "${!n}" = -o ]; then
    index=$((n + 1))
    out="${!index}"
  fi
done
case "$url" in
  https://raw.githubusercontent.com/telium-chat/telium/main/deploy/*)
    cp "/repo/deploy/${url##*/}" "$out"
    ;;
  http://127.0.0.1:8448/_telium/v1/health)
    test -f "$MOCK_WORK/state/active" || exit 1
    server="$(sed -nE 's/^[[:space:]]*server_name[[:space:]]*=[[:space:]]*"([^"]+)"[[:space:]]*(#.*)?$/\1/p' /etc/telium/telium.toml | head -1)"
    if [ "${MOCK_UNHEALTHY:-0}" = 1 ]; then
      printf '{"ok":false,"server_name":"%s"}\n' "$server"
    else
      printf '{"ok":true,"server_name":"%s"}\n' "$server"
    fi
    ;;
  *SHA256SUMS-server)
    digest="$(sha256sum "$MOCK_WORK/releases/v$MOCK_STAGE/telium-server-linux-x86_64.tar.gz" | cut -d' ' -f1)"
    printf '%s  %s\n' "$digest" 'telium-server-linux-x86_64.tar.gz' > "$out"
    ;;
  *telium-server-linux-x86_64.tar.gz|*server-linux-x86_64.tar.gz)
    cp "$MOCK_WORK/releases/v$MOCK_STAGE/telium-server-linux-x86_64.tar.gz" "$out"
    ;;
  *)
    echo "unexpected curl: $url" >&2
    exit 1
    ;;
esac
MOCK_CURL

cat > "$work/bin/systemctl" <<'MOCK_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  daemon-reload) ;;
  enable)
    if [[ " $* " == *" --now "* ]] && [ ! -f "$MOCK_WORK/state/active" ]; then
      touch "$MOCK_WORK/state/active"
      /usr/local/bin/telium-server version | sed -n 's/^commit=//p' > "$MOCK_WORK/state/active_commit"
    fi
    ;;
  restart)
    test "$2" = telium-server.service
    [ "${MOCK_RESTART_FAIL:-0}" != 1 ] || { echo "mock restart failure" >&2; exit 1; }
    touch "$MOCK_WORK/state/active"
    /usr/local/bin/telium-server version | sed -n 's/^commit=//p' > "$MOCK_WORK/state/active_commit"
    echo restarted >> "$MOCK_WORK/state/restarts"
    ;;
  show) echo 1 ;;
  is-active) test -f "$MOCK_WORK/state/active" ;;
  kill) ;;
  *)
    echo "unexpected systemctl command: $*" >&2
    exit 1
    ;;
esac
MOCK_SYSTEMCTL

# The fake server binary is a shell script. Simulate the systemd process inode
# with stat so live-executable checks can detect mismatches in this fixture.
cat > "$work/bin/stat" <<'MOCK_STAT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -Lc ] && [ "${2:-}" = %d:%i ] &&
   [[ "${3:-}" == /proc/*/exe ]]; then
  if [ "${MOCK_STALE_PROCESS:-0}" = 1 ]; then
    echo stale
  else
    /usr/bin/stat -Lc '%d:%i' /usr/local/bin/telium-server
  fi
else
  exec /usr/bin/stat "$@"
fi
MOCK_STAT
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"

# The fake binaries exercise the CLI contract, including multi-line backup
# output and the difference between an old and a new 'check --help'.
for version in 1 2 3 4 5; do
  mkdir -p "$work/releases/v$version"
  cat > "$work/releases/v$version/telium-server" <<'MOCK_BINARY'
#!/usr/bin/env bash
set -euo pipefail
config=/etc/telium/telium.toml
if [ "${1:-}" = --config ]; then
  config="$2"
  shift 2
fi
case "${1:-}" in
  version)
    echo "commit=__COMMIT__"
    echo "commit_time=__TIME__"
    ;;
  check)
    if [ "${2:-}" = --help ]; then
      echo "check [--strict] __HELP__"
    else
      [ "${2:-}" != --installation ] || [ "__VERSION__" -gt 1 ] || exit 77
      if [ "${2:-}" = --installation ]; then
        echo installation >> "$MOCK_WORK/state/check_flags"
        echo "Configuration check passed."
      else
        echo "profile: production"
        echo "Nothing dangerous."
      fi
    fi
    ;;
  registration-code)
    if [ "${2:-}" = --help ]; then exit 0; fi
    [ "${2:-}" = bootstrap ] || exit 70
    [ "$PWD" = /var/lib/telium ] || { echo "wrong CLI cwd: $PWD" >&2; exit 71; }
    if grep -qE '^open = true$' "$config"; then
      echo 'registration is public; no setup code is needed'
    elif [ ! -e /var/lib/telium/setup-code-created ]; then
      touch /var/lib/telium/setup-code-created
      echo 'Initial private registration code (one use, expires in 30 days):'
      echo 'treg_SMOKE_TEST_SECRET_NEVER_USE'
      echo 'This secret cannot be displayed again. Save it now.'
    else
      echo 'the initial code was already created and cannot be displayed again. If lost or expired, use the local registration-code create command.'
    fi
    ;;
  updates)
    [ "${2:-}" = check ] || exit 72
    if [ "__VERSION__" -eq "$MOCK_STAGE" ]; then
      echo "action=current"
    else
      echo "action=update"
      echo "ours=__COMMIT__"
      echo "target_commit=$(printf '%040d' "$MOCK_STAGE")"
      echo "target_released_at=4000"
      echo 'target_version=0.99.0'
      echo "artifact_url=https://mock/server-linux-x86_64.tar.gz"
      echo "artifact_sha256=$(sha256sum "$MOCK_WORK/releases/v$MOCK_STAGE/telium-server-linux-x86_64.tar.gz" | cut -d' ' -f1)"
      echo "artifact_size=1048576"
      echo "breaking=${MOCK_BREAKING:-false}"
    fi
    ;;
  backup)
    [ "${2:-}" = now ] || exit 73
    [ "$PWD" = /var/lib/telium ] || { echo "wrong backup cwd: $PWD" >&2; exit 74; }
    if [ "${MOCK_BACKUP_FAIL:-0}" = 1 ]; then
      echo "mock backup failed" >&2
      exit 75
    fi
    mkdir -p /var/backups/telium/archives
    archive=/var/backups/telium/archives/snapshot.test
    printf 'backup contents' > "$archive"
    echo "$archive"
    echo 'files: 4'
    echo 'format: telium-backup-v1'
    ;;
  *)
    echo "unsupported test command: $*" >&2
    exit 76
    ;;
esac
MOCK_BINARY
  sed -i \
    -e "s/__COMMIT__/$(printf '%040d' "$version")/g" \
    -e "s/__TIME__/$((1000 * version))/g" \
    -e "s/__VERSION__/$version/g" \
    -e "s/__HELP__/$([ "$version" -gt 1 ] && echo --installation || true)/g" \
    "$work/releases/v$version/telium-server"
  chmod +x "$work/releases/v$version/telium-server"
  printf '# reference for version %s\n' "$version" > "$work/releases/v$version/telium.example.toml"
  tar -C "$work/releases/v$version" -czf "$work/releases/v$version/telium-server-linux-x86_64.tar.gz" telium-server telium.example.toml
done

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_contains() { grep -Fq "$2" "$1" || fail "$1 missing '$2'"; }
assert_absent() { if grep -Fq "$2" "$1"; then fail "$1 unexpectedly has '$2'"; fi; }
binary_commit() { /usr/local/bin/telium-server version | sed -n 's/^commit=//p'; }
assert_live_matches_binary() {
  [ "$(cat "$work/state/active_commit")" = "$(binary_commit)" ] || fail "active service does not run installed binary"
}

# Reject malformed domains before writing anything.
for name in chat..test -chat.test chat-.test chat_test.test; do
  if TELIUM_REGISTRATION=closed bash deploy/install-native.sh "$name" > "$work/bad-domain.log" 2>&1; then
    fail "accepted invalid domain: $name"
  fi
done

# An unattended installer without an explicit policy must fail *before* it
# downloads a binary or creates a server configuration.
if env -u TELIUM_REGISTRATION bash deploy/install-native.sh chat.test > "$work/no-policy.log" 2>&1; then
  fail "unattended setup guessed a registration policy"
fi
assert_contains "$work/no-policy.log" "TELIUM_REGISTRATION=closed or"
test ! -e /usr/local/bin/telium-server || fail "unattended preflight installed a binary"

# Fresh install on an older compatible release: no --installation support
# must not prevent startup or the one-time private signup code.
export TELIUM_REGISTRATION=closed
( cd / && bash /repo/deploy/bootstrap-native.sh CHAT.TEST ) > "$work/fresh.log" 2>&1
assert_contains "$work/fresh.log" "Starting the Telium native installer"
assert_contains "$work/fresh.log" "registration PRIVATE"
assert_contains "$work/fresh.log" "setup uses root privileges"
assert_contains "$work/fresh.log" "Initial private registration code"
assert_contains /etc/telium/telium.toml 'server_name = "chat.test"'
assert_contains /etc/telium/telium.toml 'client_url = "https://telium.chat"'
assert_contains /etc/telium/telium.toml 'default = "quota"'
assert_contains /etc/telium/telium.toml 'quota_bytes = "1GiB"'
assert_contains /etc/telium/telium.toml 'max_file_bytes = "50MiB"'
assert_contains /etc/telium/telium.toml 'attachment_max_age_days = 0'
assert_contains /etc/telium/telium.toml 'include_media = true'
assert_contains /etc/telium/telium.toml 'interval_secs = "6h"'
assert_contains /etc/telium/telium.toml 'min_free_bytes = "'
assert_contains "$work/fresh.log" 'Found '
assert_contains "$work/fresh.log" "Enter the one-time registration code shown above"
assert_live_matches_binary
[ ! -e "$work/state/restarts" ] || fail "fresh install should not restart"
[ "$(binary_commit)" = "$(printf '%040d' 1)" ] || fail "unexpected first-release binary"

# Rerun against the active server: the installer must never replace the
# binary on its own. The native updater takes the snapshot and restarts.
export MOCK_STAGE=2
echo 'TELIUM_RESTART_NOTICE_SECS=0' >> /etc/telium/update.conf
echo 'TELIUM_HEALTH_RETRIES=2' >> /etc/telium/update.conf
# A unit modified directly by an operator must not be overwritten on reruns.
echo '# operator-only hardening override' >> /etc/systemd/system/telium-server.service
if bash deploy/install-native.sh other.test > "$work/wrong-domain.log" 2>&1; then
  fail "installer accepted a different domain for an existing homeserver"
fi
assert_contains "$work/wrong-domain.log" "use the domain relocation procedure"
bash deploy/install-native.sh chat.test > "$work/rerun.log" 2>&1
assert_contains /etc/systemd/system/telium-server.service '# operator-only hardening override'
assert_contains "$work/rerun.log" 'preserved existing /etc/systemd/system/telium-server.service'
assert_contains "$work/rerun.log" "keeping the installed binary"
assert_contains "$work/rerun.log" "backup: /var/backups/telium/archives/snapshot.test"
assert_contains "$work/rerun.log" "deployed "
assert_contains "$work/rerun.log" "Enter your saved private registration code"
assert_contains "$work/rerun.log" "existing configuration and administrator access were preserved"
assert_contains /etc/telium/telium.toml 'attachment_max_age_days = 0'
assert_contains /etc/telium/telium.toml 'include_media = true'
assert_absent "$work/rerun.log" 'Storage configuration'
assert_absent "$work/rerun.log" "Enter the one-time registration code shown above"
assert_absent "$work/rerun.log" "admin recover USERNAME"
assert_absent "$work/rerun.log" "1. point DNS:"
test -s "$work/state/restarts" || fail "upgrader did not restart the active service"
assert_live_matches_binary
[ "$(binary_commit)" = "$(printf '%040d' 2)" ] || fail "upgrader did not install release 2"
test -f /usr/local/bin/telium-server.previous || fail "previous executable was not retained"

# An explicit breaking hold is respected even on manual installer reruns.
export MOCK_STAGE=3 MOCK_BREAKING=true
bash deploy/install-native.sh chat.test > "$work/breaking.log" 2>&1
assert_contains "$work/breaking.log" "needs a person"
assert_live_matches_binary
[ "$(binary_commit)" = "$(printf '%040d' 2)" ] || fail "breaking hold was overridden"

# A missing backup is fatal, and does not swap the executable or restart.
unset MOCK_BREAKING
export MOCK_BACKUP_FAIL=1
if bash deploy/install-native.sh chat.test > "$work/failed-backup.log" 2>&1; then
  fail "installer did not stop when pre-update backup failed"
fi
assert_contains "$work/failed-backup.log" "pre-install backup produced no archive"
assert_live_matches_binary
[ "$(binary_commit)" = "$(printf '%040d' 2)" ] || fail "binary changed without a backup"

unset MOCK_BACKUP_FAIL

# Check the failure path when the executable is replaced but the new server
# cannot prove healthy (mocked database health returns false).
export MOCK_STAGE=3 MOCK_UNHEALTHY=1
if bash deploy/install-native.sh chat.test > "$work/unhealthy.log" 2>&1; then
  fail "updater accepted an unhealthy server"
fi
assert_contains "$work/unhealthy.log" "pre-upgrade backup:"
assert_contains "$work/unhealthy.log" "inspect: journalctl -u"
assert_contains "$work/unhealthy.log" "the local health endpoint failed"
unset MOCK_UNHEALTHY

# A failed systemd restart must print recovery instructions despite set -e.
export MOCK_STAGE=4 MOCK_RESTART_FAIL=1
if bash deploy/install-native.sh chat.test > "$work/restart-failed.log" 2>&1; then
  fail "updater reported success after systemctl restart failed"
fi
assert_contains "$work/restart-failed.log" "mock restart failure"
assert_contains "$work/restart-failed.log" "pre-upgrade backup:"
assert_contains "$work/restart-failed.log" "do NOT swap the old executable"
unset MOCK_RESTART_FAIL

# A service that responds but still executes the *old* binary is not healthy.
export MOCK_STAGE=5 MOCK_STALE_PROCESS=1
if bash deploy/install-native.sh chat.test > "$work/stale-process.log" 2>&1; then
  fail "updater accepted stale service executable"
fi
assert_contains "$work/stale-process.log" "the service process is stale"
unset MOCK_STALE_PROCESS

# The UI for open registration must not talk about invitation codes.
rm -rf /etc/telium /var/lib/telium /var/backups/telium /var/lib/telium-update
rm -f /usr/local/bin/telium-server /usr/local/bin/telium-server.previous
rm -f "$work/state/"*
export MOCK_STAGE=1 TELIUM_REGISTRATION=open
unset MOCK_BACKUP_FAIL
bash deploy/install-native.sh open.test > "$work/open.log" 2>&1
assert_contains "$work/open.log" "Registration is open; no invitation code is required."
assert_contains /etc/telium/telium.toml 'attachment_max_age_days = 30'
assert_contains /etc/telium/telium.toml 'max_expiry_secs = "30d"'
assert_contains /etc/telium/telium.toml 'include_media = false'
assert_contains "$work/open.log" 'Backups EXCLUDE uploaded files'
assert_absent "$work/open.log" "Further registration codes"
assert_absent "$work/open.log" "If your setup code was lost"
assert_live_matches_binary

# A previously interrupted first install may have written the executable
# without committing config. With no database and no running unit, retrying
# should complete rather than demand restoration of a nonexistent config.
rm -rf /etc/telium /var/lib/telium /var/backups/telium /var/lib/telium-update
rm -f /usr/local/bin/telium-server /usr/local/bin/telium-server.previous
rm -f "$work/state/"*
install -m755 "$work/releases/v1/telium-server" /usr/local/bin/telium-server
export MOCK_STAGE=1 TELIUM_REGISTRATION=closed
mkdir -p /var/lib/telium
echo "must not delete" > /var/lib/telium/orphaned-data
if bash deploy/install-native.sh recovery.test > "$work/refuse-orphaned-data.log" 2>&1; then
  fail "installer overwrote a partial install with server data present"
fi
assert_contains "$work/refuse-orphaned-data.log" "server data or backups remain"
test -f /var/lib/telium/orphaned-data || fail "interrupted state was lost"
rm -rf /var/lib/telium
bash deploy/install-native.sh recovery.test > "$work/recovery.log" 2>&1
assert_contains "$work/recovery.log" "recovering an interrupted first install"
assert_contains "$work/recovery.log" "Initial private registration code"
assert_live_matches_binary

# Unattended custom storage policy: all fields must land in the first config.
rm -rf /etc/telium /var/lib/telium /var/backups/telium /var/lib/telium-update
rm -f /usr/local/bin/telium-server /usr/local/bin/telium-server.previous
rm -f "$work/state/"*
export MOCK_STAGE=1 TELIUM_REGISTRATION=open
export TELIUM_MEDIA_POLICY=quota TELIUM_MEDIA_QUOTA=256MiB TELIUM_MEDIA_FILE_MAX=100MiB
export TELIUM_MEDIA_TOTAL=1GiB TELIUM_MEDIA_FREE_RESERVE=1GiB TELIUM_MEDIA_RETENTION_DAYS=7
export TELIUM_BACKUP_MEDIA=yes TELIUM_BACKUP_INTERVAL=12h TELIUM_BACKUP_KEEP=3
export TELIUM_BACKUP_FREE_RESERVE=1GiB
bash deploy/install-native.sh custom.test > "$work/custom.log" 2>&1
assert_contains /etc/telium/telium.toml 'quota_bytes = "256MiB"'
assert_contains /etc/telium/telium.toml 'max_file_bytes = "100MiB"'
assert_contains /etc/telium/telium.toml 'max_total_bytes = "1GiB"'
assert_contains /etc/telium/telium.toml 'attachment_max_age_days = 7'
assert_contains /etc/telium/telium.toml 'include_media = true'
assert_contains /etc/telium/telium.toml 'interval_secs = "12h"'
assert_contains /etc/telium/telium.toml 'keep = 3'
unset TELIUM_MEDIA_POLICY TELIUM_MEDIA_QUOTA TELIUM_MEDIA_FILE_MAX TELIUM_MEDIA_TOTAL
unset TELIUM_MEDIA_FREE_RESERVE TELIUM_MEDIA_RETENTION_DAYS TELIUM_BACKUP_MEDIA
unset TELIUM_BACKUP_INTERVAL TELIUM_BACKUP_KEEP TELIUM_BACKUP_FREE_RESERVE

# A malformed override fails before committing a new configuration.
rm -rf /etc/telium /var/lib/telium /var/backups/telium /var/lib/telium-update
rm -f /usr/local/bin/telium-server /usr/local/bin/telium-server.previous
rm -f "$work/state/"*
export TELIUM_MEDIA_QUOTA=not-a-size
if bash deploy/install-native.sh invalid-storage.test > "$work/bad-storage.log" 2>&1; then
  fail "installer accepted an invalid media quota"
fi
assert_contains "$work/bad-storage.log" 'invalid Per-user media allowance'
test ! -e /etc/telium/telium.toml || fail "invalid storage choices wrote a config"
unset TELIUM_MEDIA_QUOTA

echo 'native installer smoke: registration, storage defaults and overrides, domain, recovery and safe updates passed'
