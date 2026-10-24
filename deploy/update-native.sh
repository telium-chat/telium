#!/usr/bin/env bash
#
# The native counterpart to update.sh: ask the release manifest whether this
# box should be running something newer, and act on the answer.
#
# It exists because the container path has had an answer to "how does this box
# update itself" since the day it was provisioned, and the native path -- one
# binary, one config, systemd -- had only "install Rust and build it". A
# homeserver that can only be updated by a build farm is a homeserver whose
# operators stay on the release they started with, which is the exact outcome
# the whole update machinery exists to prevent.
#
# The shape is the container path's shape, on purpose, because the properties
# are the point and none of them belong to Docker:
#
#   * The arrow points one way. This script reaches out to GitHub; nothing in
#     GitHub knows this box exists, holds a key to it, or could reach it.
#   * Nothing is executed until it has been named by the manifest and its
#     bytes have matched the sha256 the manifest published. The manifest is
#     parsed by `telium-server updates check` -- the same parser, sanitiser
#     and signature gate the running server uses -- so the shell never
#     renders a judgement about untrusted input, and never sees one either.
#   * A breaking release, a configuration the new binary refuses, and a
#     release with no native artifact all stop here, loudly, with the
#     artifact staged. An unattended box takes every ordinary release and
#     waits for a person at the ones that need one.
#   * `telium.toml` is never written. The reference config ships alongside
#     the binary, refreshed on install, to `diff` when you feel like it.
#
# And one property the container path gets from the registry that a file
# download has to earn back: a backup is taken before the swap, every time,
# without exception. Forward-only migrations mean the backup is the only way
# back once a new binary has started -- see docs/upgrade.md -- so the updater
# refuses to move a box it could not first snapshot.
#
# What this script is not: a rollback mechanism. There is no automatic one,
# by choice -- the same choice the container path makes. If a new release
# fails to come back up, this script says so and says what the backup under
# the box is for, and stops. A person decides what happens next.

set -euo pipefail

# One updater at a time. The timer and an operator running --now by hand can
# otherwise interleave a backup, a swap and two restarts, and the failure
# modes of that interleave are all worse than skipping a tick.
LOCK=/run/telium-update-native.lock

STATE=/var/lib/telium-update
CONF=/etc/telium/update.conf
SELF="$(readlink -f "$0")"

# Defaults, then whatever the operator said. A box with no update.conf gets
# exactly the behaviour of a box with this one unedited: automatic, unpinned,
# no window. The first four fields are the container path's fields and mean
# the same things; the rest are this path's own. TELIUM_ARTIFACT is left
# empty here on purpose -- see just below.
TELIUM_UPDATES=automatic
TELIUM_PIN=
TELIUM_PIN_REASON=
TELIUM_UPDATE_WINDOW=
TELIUM_ARTIFACT=
TELIUM_SERVER_BIN=/usr/local/bin/telium-server
TELIUM_CONFIG=/etc/telium/telium.toml
TELIUM_UNIT=telium-server.service
TELIUM_SERVICE_USER=telium
TELIUM_MANIFEST_URL=
if [ -r "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi

# Which artifact a release must publish for this box, derived from the CPU
# when the operator said nothing -- because the whole point of this path is
# that a Raspberry Pi and a VPS need zero configuration to update
# themselves. The two names are the ones releases are published under
# (docs/updates.md); anything else is a decision for the docs to make before
# this script guesses, so an exotic CPU stops here with the one line that
# says what to set.
if [ -z "$TELIUM_ARTIFACT" ]; then
  machine="$(uname -m)"
  case "$machine" in
    x86_64) TELIUM_ARTIFACT=server-linux-x86_64 ;;
    aarch64) TELIUM_ARTIFACT=server-linux-aarch64 ;;
    *)
      echo "ERROR: $machine is not an architecture releases are published for. If this box can run one anyway, set TELIUM_ARTIFACT in $CONF." >&2
      exit 1
      ;;
  esac
fi

FORCE_NOW=0
case "${1:-}" in
  --now)
    # `manual` means "do not do this on a timer", not "never do this". This
    # is the operator saying now -- the window, the hold and the mode are
    # all their own settings, and all three yield to them in person.
    FORCE_NOW=1
    ;;
  --status)
    echo "mode:    $TELIUM_UPDATES"
    echo "pin:     ${TELIUM_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_UPDATE_WINDOW:-<any time>}"
    echo "unit:    $TELIUM_UNIT"
    echo "binary:  $TELIUM_SERVER_BIN"
    echo "artifact: $TELIUM_ARTIFACT"
    running="$("$TELIUM_SERVER_BIN" version 2>/dev/null | sed -n 's/^commit=//p')"
    echo "running: ${running:-<unknown>}"
    if [ -f "$STATE/staged/commit" ]; then
      echo "staged:  $(head -c 12 "$STATE/staged/commit") is downloaded, checked, and waiting; --now takes it"
    fi
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: ${0##*/} [--now | --status]" >&2
    exit 2
    ;;
esac

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another update run holds the lock; nothing to do"
  exit 0
fi

mkdir -p "$STATE"

# --------------------------------------------------------------- helpers

# Said once per pending release rather than once per tick. The container
# path's rule, for the same reason: a journal that repeats the same line
# between midnight and the window is a journal nobody reads.
announce_once() {
  local marker="$STATE/$1" value="$2" message="$3"
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$value" ]; then
    printf '%s\n' "$value" > "$marker"
    echo "$message"
  fi
}

# Inside the operator's window or not at all -- verbatim from update.sh,
# because a maintenance window with an exception is not a maintenance window.
# A security release waits for 02:00 like everything else, and the log says
# it is waiting.
in_window() {
  if [ -z "$TELIUM_UPDATE_WINDOW" ]; then
    return 0
  fi
  # A typo in this field must not be able to hold a security release. An
  # unparseable window is treated as no window at all, loudly, because the
  # alternative is a box that quietly stops updating and a setting nobody
  # looks at twice.
  if [[ ! "$TELIUM_UPDATE_WINDOW" =~ ^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$ ]]; then
    echo "WARNING: TELIUM_UPDATE_WINDOW=${TELIUM_UPDATE_WINDOW} is not HH:MM-HH:MM; ignoring it" >&2
    return 0
  fi
  local start end now
  start="${TELIUM_UPDATE_WINDOW%%-*}"
  end="${TELIUM_UPDATE_WINDOW##*-}"
  now="$(date +%H%M)"
  start="${start/:/}"
  end="${end/:/}"
  # 10# forces base ten: "0800" is not octal, whatever bash thinks.
  if [ "$((10#$start))" -le "$((10#$end))" ]; then
    [ "$((10#$now))" -ge "$((10#$start))" ] && [ "$((10#$now))" -lt "$((10#$end))" ]
  else
    # Wraps midnight.
    [ "$((10#$now))" -ge "$((10#$start))" ] || [ "$((10#$now))" -lt "$((10#$end))" ]
  fi
}

# A pin with no stated reason is reported on every run, forever. It is still
# honoured -- overriding an operator's explicit choice because they left a
# field blank would be the software deciding it knows better -- but it does
# not get to be quiet either. Same words as the container path, because it is
# the same trap: the pin will outlive the memory of why it was set.
if [ -n "$TELIUM_PIN" ]; then
  if [ -n "$TELIUM_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_PIN" \
      "pinned to ${TELIUM_PIN:0:12}. Reason on file: ${TELIUM_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_PIN:0:12} with no TELIUM_PIN_REASON." >&2
    echo "ERROR: the pin is being honoured. Write down why it is there, or clear it." >&2
  fi
fi

if [ ! -x "$TELIUM_SERVER_BIN" ]; then
  echo "ERROR: no server binary at $TELIUM_SERVER_BIN to ask or to replace." >&2
  exit 1
fi

# ------------------------------------------------- what this box should do
#
# Fetch, verify, parse and decide -- in the binary, not here. The script's
# whole relationship with the manifest is: run one command, read key=value
# lines, act. Exit non-zero means "I could not find out", which is a
# different thing from "stay put", and it stops the run: a box that cannot
# establish what it should be running does not guess and install anyway.

plan="$STATE/plan"
if ! "$TELIUM_SERVER_BIN" --config "$TELIUM_CONFIG" updates check \
    --artifact "$TELIUM_ARTIFACT" \
    ${TELIUM_PIN:+--pin "$TELIUM_PIN"} \
    ${TELIUM_MANIFEST_URL:+--manifest-url "$TELIUM_MANIFEST_URL"} \
    > "$plan"; then
  echo "ERROR: the update check failed; this box does not know where it stands." >&2
  exit 1
fi

# key=${line%%=*} keeps everything before the first =, value=${line#*=}
# everything after it -- so a URL with an = in its query string lands whole.
get() { sed -n "s/^$1=//p" "$plan" | head -1; }

action="$(get action)"
ours="$(get ours)"
after="$(get target_commit)"
artifact_url="$(get artifact_url)"
artifact_sha256="$(get artifact_sha256)"
artifact_size="$(get artifact_size)"
target_released_at="$(get target_released_at)"
breaking="$(get breaking)"
notes="$(get notes)"

# ------------------------------------------------------------- the answers

case "$action" in
  current)
    # Silence is the healthy state. The one piece of housekeeping: re-arm the
    # announcements, so that if this box falls behind again it says so once,
    # from the beginning, rather than inheriting a silence it did not choose.
    rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking" \
      "$STATE/no-artifact" "$STATE/not-published" "$STATE/check-failed"
    exit 0
    ;;
  unidentified_build)
    echo "ERROR: $TELIUM_SERVER_BIN does not record which commit it came from, so it cannot" >&2
    echo "ERROR: be compared against published releases. Install a release-built binary" >&2
    echo "ERROR: (deploy/telium-server.service or docs/production.md) before updating." >&2
    exit 1
    ;;
  not_published)
    if [ -n "$TELIUM_PIN" ]; then
      echo "ERROR: TELIUM_PIN names ${TELIUM_PIN:0:12}, which the release manifest does not list." >&2
      echo "ERROR: The pin is honoured in the sense that nothing moved; clear or correct it to follow the channel." >&2
    else
      announce_once not-published "$ours" \
        "this build is not in the release manifest, so how current it is cannot be established -- a fork, a hand build, or a release older than the manifest remembers"
    fi
    exit 1
    ;;
  # Everything below the case is the update path; this branch exists so the
  # catch-all under it stays a catch-all for answers neither side
  # understands, rather than becoming the way `update` reaches it.
  update)
    ;;
  *)
    # The parser and this script ship from the same commit in practice, but
    # not in theory: the binary on disk can be older than the script. An
    # answer neither understands is a stop, not a guess.
    echo "ERROR: the update check answered '$action', which this script does not understand; update the script and the binary together." >&2
    exit 1
    ;;
esac

# Everything below is the update path.
before="${ours:0:12}"
after_short="${after:0:12}"
target_version="$(get target_version)"
# What to call the release in a log line: the version when the release states
# one, the commit otherwise. Both are true names -- a release that predates
# versions has only the commit, and printing an invented 0.0.0 for it would be
# worse than printing nothing.
if [ -n "$target_version" ]; then
  after_name="${target_version} (${after_short})"
else
  after_name="${after_short}"
fi

# A release with no installable artifact is not an error in the manifest; it
# is the ordinary state of every release published before native artifacts
# existed. It is also nothing this script can do, and the container image is
# the supported way to run such a release.
if [ -z "$artifact_url" ]; then
  announce_once no-artifact "$after" \
    "release ${after_short} publishes no native artifact for ${TELIUM_ARTIFACT}; it ships only as a container image, and this box stays where it is"
  exit 1
fi

# Refuse to move backwards. The manifest can be aimed at an older release
# only through a pin, and the reason native refuses what the container path
# permits is the database: a binary older than the last release that migrated
# this SQLite file will refuse it on start, and the result of "updating"
# backwards is a service that no longer starts. The way back on this path is
# a restore, and docs/upgrade.md says so at length.
ours_time="$("$TELIUM_SERVER_BIN" version | sed -n 's/^commit_time=//p')"
if [ -n "$ours_time" ] && [ -n "$target_released_at" ] \
   && [ "$ours_time" -gt "$target_released_at" ]; then
  announce_once downgrade "$after" \
    "the pinned release ${after_short} is older than the one this box runs (${before}); downgrading over a migrated database would leave it unable to start -- restore a backup instead, see docs/upgrade.md"
  exit 1
fi

# ------------------------------------------------- get it on disk, safely

# Already staged is already staged: the timer runs every few minutes, and a
# box in a window or holding for a person must not re-download the same
# release on every tick. The commit marker is written only after the
# download, the digest check and the identity check have all passed, so a
# half-staged directory from a killed run simply stages again.
if [ "$(cat "$STATE/staged/commit" 2>/dev/null || true)" != "$after" ] \
   || [ ! -x "$STATE/staged/telium-server" ]; then
  rm -rf "$STATE/staged"
  mkdir -p "$STATE/staged"
  tarball="$STATE/staged/artifact.tar.gz"
  # -L: a GitHub release asset answers with a redirect to the CDN. The
  # redirect is unexamined on purpose -- unlike the manifest fetch, which
  # refuses to follow one, the integrity of these bytes is not a property of
  # their transport. It is a property of the sha256 below, which the manifest
  # published and which the running server verified.
  max_bytes="${artifact_size:-268435456}"
  if ! curl -fsSL --connect-timeout 15 --max-time 900 --max-filesize "$max_bytes" \
        -o "$tarball" "$artifact_url"; then
    echo "ERROR: the artifact download failed; this box stays on ${before}." >&2
    exit 1
  fi
  # The digest is the whole of the trust chain after the manifest. Refusing
  # is the only branch.
  if ! echo "${artifact_sha256}  $tarball" | sha256sum --check --quiet >/dev/null 2>&1; then
    echo "ERROR: the downloaded artifact does not match the sha256 the manifest published; it is deleted and this box stays on ${before}." >&2
    rm -f "$tarball"
    exit 1
  fi
  if ! tar -xzf "$tarball" -C "$STATE/staged" telium-server telium.example.toml; then
    echo "ERROR: the downloaded artifact is not the archive it claimed to be; this box stays on ${before}." >&2
    rm -f "$tarball"
    exit 1
  fi
  rm -f "$tarball"
  # The sha256 proved the bytes are the ones the release published. This
  # proves the published bytes are the release this run aimed at, and -- as
  # a side effect of asking -- that the binary so much as runs on this
  # kernel and architecture. A wrong-arch artifact now costs a log line
  # instead of a restart loop.
  staged_commit="$("$STATE/staged/telium-server" version 2>/dev/null | sed -n 's/^commit=//p')"
  if [ "$staged_commit" != "$after" ]; then
    echo "ERROR: the staged binary names ${staged_commit:-<nothing>}, not ${after_short}; it does not run here or is not what the release published. This box stays on ${before}." >&2
    rm -rf "$STATE/staged"
    exit 1
  fi
  echo "$after" > "$STATE/staged/commit"
  echo "staged ${after_short}: downloaded, digest-checked, and it names itself ${after_short}"
  if [ -n "$notes" ]; then
    echo "upgrade notes: ${notes}"
  fi
fi

# The staged binary audits the live config before anything restarts. It
# opens no database, so this is free of side effects; what it buys is that a
# configuration the new release considers dangerous stops the update here --
# where the operator still has a running server -- instead of at
# ExecStartPre, where the unit would refuse to start and the box would crash
# loop instead.
if ! "$STATE/staged/telium-server" --config "$TELIUM_CONFIG" check > /dev/null; then
  announce_once check-failed "$after" \
    "the staged release ${after_short} fails \`telium-server check\` against this box's configuration; it is waiting. Run the check to read why, then run: $SELF --now"
  exit 0
fi

# ------------------------------------------------------ who says it's time

# A release can say that it needs a person before it is taken. Same rule as
# the container path, same consequence: the box stops here, staged and
# waiting, and --now is the person.
if [ "$breaking" = "true" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-breaking "$after" \
    "this release says it needs a person before it is taken${notes:+ -- ${notes}}; it is staged and waiting. Run: $SELF --now"
  exit 0
fi

if [ "$TELIUM_UPDATES" != "automatic" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-manual "$after" \
    "a new release is staged and TELIUM_UPDATES is ${TELIUM_UPDATES}; run: $SELF --now"
  exit 0
fi

if ! in_window && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-window "$after" \
    "a new release is staged; installing it when the window opens (${TELIUM_UPDATE_WINDOW})"
  exit 0
fi

# --------------------------------------------------- the move, in order
#
# 1. A backup, because forward-only migrations make it the only way back.
# 2. The swap: three steps inside one directory, the last of which is a
#    rename(2), so there is no moment when the path exists but is partial.
# 3. A restart, and a wait that watches systemd rather than hoping.

# Run as the service user, so the archive is owned by the account that will
# have to read and prune it. The running server keeps serving straight
# through this: the backup is a consistent snapshot asked of SQLite, not a
# shutdown.
set +e
backup_path="$(runuser -u "$TELIUM_SERVICE_USER" -- \
  "$TELIUM_SERVER_BIN" --config "$TELIUM_CONFIG" backup now)"
backup_rc=$?
set -e
if [ -n "$backup_path" ] && [ -f "$backup_path" ]; then
  # The archive exists, which is the thing the rollback needs. A non-zero
  # exit here means its upload to the remote failed, which is a real problem
  # and exactly as urgent as it sounds -- but it does not un-write the local
  # copy, and holding today's security fix hostage to a dead S3 bucket would
  # be trading the incident in front of us for the one we are avoiding.
  if [ "$backup_rc" -ne 0 ]; then
    echo "WARNING: the pre-install backup was written but its upload failed (exit ${backup_rc}); the rollback copy is local only." >&2
  fi
  echo "backup: ${backup_path}"
else
  echo "ERROR: the pre-install backup produced no archive (exit ${backup_rc}); refusing to install. Free disk space and check [backup] in ${TELIUM_CONFIG}." >&2
  exit 1
fi

install -m755 "$STATE/staged/telium-server" "$(dirname "$TELIUM_SERVER_BIN")/.telium-server.incoming"
# One generation, kept for the ten-second kind of rollback: an operator who
# realises mid-restart that this release is wrong can put it back by hand --
# provided the database has not been migrated past it yet, which is a race
# the backup above exists to lose gracefully.
cp -a "$TELIUM_SERVER_BIN" "${TELIUM_SERVER_BIN}.previous"
mv -f "$(dirname "$TELIUM_SERVER_BIN")/.telium-server.incoming" "$TELIUM_SERVER_BIN"

# The reference config, never the live one. Every key the server reads has a
# default compiled in, so a release cannot break a telium.toml by adding to
# it -- which is exactly why this can be a diff an operator reads when they
# feel like it rather than a merge they are made to do.
example="$(dirname "$TELIUM_CONFIG")/telium.example.toml"
if ! cmp -s "$STATE/staged/telium.example.toml" "$example"; then
  install -m644 "$STATE/staged/telium.example.toml" "$example"
  echo "telium.example.toml updated; diff it against telium.toml to see what this release added"
fi

echo "installed ${before} -> ${after_name}; restarting ${TELIUM_UNIT}"
systemctl restart "$TELIUM_UNIT"

up=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$TELIUM_UNIT"; then
    up=1
    break
  fi
  sleep 1
done

if [ "$up" -eq 0 ]; then
  # The one failure this script does not clean up after, and it is important
  # to understand what NOT undoing it buys: if the new binary migrated the
  # database before failing, the previous binary can no longer open that
  # database at all, and "rolling back" the file would turn a diagnosable
  # failure into a server that refuses to start twice. The backup above is
  # the way back, and it is named here so the person paged at 3am does not
  # have to go looking for it.
  echo "ERROR: ${TELIUM_UNIT} did not come back up after the restart; the new binary is still installed." >&2
  echo "ERROR: do NOT restore ${TELIUM_SERVER_BIN}.previous by hand before reading journalctl -u ${TELIUM_UNIT}:" >&2
  echo "ERROR: if this release migrated the database, the old binary will refuse it." >&2
  echo "ERROR: the way back is the backup taken before the swap: stop the unit, then" >&2
  echo "ERROR: ${TELIUM_SERVER_BIN} --config ${TELIUM_CONFIG} restore latest --yes" >&2
  exit 1
fi

running="$("$TELIUM_SERVER_BIN" version | sed -n 's/^commit=//p')"
if [ "$running" != "$after" ]; then
  echo "WARNING: the unit is active but the binary on disk names ${running:-<unknown>}; it will be running after the next restart." >&2
fi

rm -rf "$STATE/staged"
rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking" \
  "$STATE/no-artifact" "$STATE/not-published" "$STATE/check-failed" "$STATE/downgrade"

echo "deployed ${before} -> ${after_short}"
