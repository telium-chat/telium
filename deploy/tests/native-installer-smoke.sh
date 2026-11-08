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
  http://127.0.0.1:8448/_telium/v1/health)
    test -f "$MOCK_WORK/state/active"
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
    touch "$MOCK_WORK/state/active"
    /usr/local/bin/telium-server version | sed -n 's/^commit=//p' > "$MOCK_WORK/state/active_commit"
    echo restarted >> "$MOCK_WORK/state/restarts"
    ;;
  is-active) test -f "$MOCK_WORK/state/active" ;;
  kill) ;;
  *)
    echo "unexpected systemctl command: $*" >&2
    exit 1
    ;;
esac
MOCK_SYSTEMCTL
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"

# The fake binaries exercise the CLI contract, including multi-line backup
# output and the difference between an old and a new 'check --help'.
for version in 1 2 3; do
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

# Fresh install on an older compatible release: no --installation support
# must not prevent startup or the one-time private signup code.
export TELIUM_REGISTRATION=closed
bash deploy/install-native.sh chat.test > "$work/fresh.log" 2>&1
assert_contains "$work/fresh.log" "registration PRIVATE"
assert_contains "$work/fresh.log" "Initial private registration code"
assert_contains "$work/fresh.log" "Enter the one-time registration code shown above"
assert_live_matches_binary
[ ! -e "$work/state/restarts" ] || fail "fresh install should not restart"
[ "$(binary_commit)" = "$(printf '%040d' 1)" ] || fail "unexpected first-release binary"

# Rerun against the active server: the installer must never replace the
# binary on its own. The native updater takes the snapshot and restarts.
export MOCK_STAGE=2
echo 'TELIUM_RESTART_NOTICE_SECS=0' >> /etc/telium/update.conf
bash deploy/install-native.sh chat.test > "$work/rerun.log" 2>&1
assert_contains "$work/rerun.log" "keeping the installed binary"
assert_contains "$work/rerun.log" "backup: /var/backups/telium/archives/snapshot.test"
assert_contains "$work/rerun.log" "deployed "
assert_contains "$work/rerun.log" "Enter your saved private registration code"
assert_absent "$work/rerun.log" "Enter the one-time registration code shown above"
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

# The UI for open registration must not talk about invitation codes.
rm -rf /etc/telium /var/lib/telium /var/backups/telium /var/lib/telium-update
rm -f /usr/local/bin/telium-server /usr/local/bin/telium-server.previous
rm -f "$work/state/"*
export MOCK_STAGE=1 TELIUM_REGISTRATION=open
unset MOCK_BACKUP_FAIL
bash deploy/install-native.sh open.test > "$work/open.log" 2>&1
assert_contains "$work/open.log" "Registration is open; no invitation code is required."
assert_absent "$work/open.log" "Further registration codes"
assert_absent "$work/open.log" "If your setup code was lost"
assert_live_matches_binary

echo 'native installer smoke: fresh, active upgrade, breaking hold, backup failure and open registration passed'
