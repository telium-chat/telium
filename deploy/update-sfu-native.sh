#!/usr/bin/env bash
#
# The SFU's native counterpart to update-native.sh: ask the release manifest
# whether this relay should be running something newer, and act on the answer.
#
# It exists for the same reason the server's does: sfu/install.sh put one
# binary, one config and systemd on the box, and without this script the only
# way forward was "build it yourself again". A relay that cannot update is a
# relay whose operators stay on the release they started with.
#
# The shape is the server native path's shape, on purpose:
#
#   * The arrow points one way. This script reaches out to GitHub; nothing in
#     GitHub knows this box exists, holds a key to it, or could reach it.
#   * Nothing is executed until it has been named by the manifest and its
#     bytes have matched the sha256 the manifest published. The manifest is
#     parsed by `telium-sfu updates check` -- the same parser, sanitiser and
#     signature gate the running relay uses -- so the shell never renders a
#     judgement about untrusted input, and never sees one either.
#   * A breaking release, a configuration the new binary refuses, and a
#     release with no native artifact all stop here, loudly, with the
#     artifact staged. An unattended relay takes every ordinary release and
#     waits for a person at the ones that need one.
#   * `sfu.toml` is never written. The reference config ships alongside the
#     binary, refreshed on install, to `diff` when you feel like it.
#
# Two things are different from the server's script, and both trace to the
# relay having no database:
#
#   * The pre-swap backup is a copy of the usage ledger -- the only state the
#     binary owns -- rather than a database snapshot. It is best-effort: a
#     lost ledger resets an estimate to zero, it does not lose calls.
#   * A restart that does not come back is ROLLED BACK, once. The server
#     refuses to do this because its old binary may no longer open a migrated
#     database; the relay has no such trap, and a media relay that is down is
#     worse than a media relay on yesterday's release. One rollback attempt,
#     then this script says so and stops -- a flip-flop is a person's problem.
#
# Before the swap, the running relay is asked to drain: SIGUSR1 makes it
# refuse new joins (and /health says so, so the directory stops routing to
# it) while live calls finish, inside updates.drain_max_secs. This script
# waits for rooms to empty within TELIUM_SFU_DRAIN_TIMEOUT, then goes anyway
# -- the ceiling exists so the update happens.

set -euo pipefail

# One updater at a time. The timer and an operator running --now by hand can
# otherwise interleave a drain, a swap and two restarts, and the failure modes
# of that interleave are all worse than skipping a tick.
LOCK=${TELIUM_SFU_UPDATE_LOCK:-/run/telium-update-sfu-native.lock}

STATE=${TELIUM_SFU_UPDATE_STATE:-/var/lib/telium-update-sfu}
CONF=${TELIUM_SFU_UPDATE_CONFIG:-/etc/telium/update-sfu.conf}
SELF="$(readlink -f "$0")"

# Defaults, then whatever the operator said. A box with no update-sfu.conf
# gets exactly the behaviour of a box with this one unedited: automatic,
# unpinned, no window. TELIUM_SFU_ARTIFACT is left empty on purpose -- see
# just below.
TELIUM_SFU_UPDATES=automatic
TELIUM_SFU_PIN=
TELIUM_SFU_PIN_REASON=
TELIUM_SFU_UPDATE_WINDOW=
TELIUM_SFU_ARTIFACT=
TELIUM_SFU_BIN=/usr/local/bin/telium-sfu
TELIUM_SFU_CONFIG=/var/lib/telium-sfu/sfu.toml
TELIUM_SFU_UNIT=telium-sfu.service
TELIUM_SFU_HEALTH_URL=http://127.0.0.1:7890/health
TELIUM_SFU_DRAIN_TIMEOUT=900
TELIUM_SFU_MANIFEST_URL=
TELIUM_SFU_USAGE_LEDGER=
if [ -r "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi

# Which artifact a release must publish for this box, derived from the CPU
# when the operator said nothing. The two names are the ones releases are
# published under; anything else stops here with the one line that says what
# to set.
if [ -z "$TELIUM_SFU_ARTIFACT" ]; then
  machine="$(uname -m)"
  case "$machine" in
    x86_64) TELIUM_SFU_ARTIFACT=sfu-linux-x86_64 ;;
    aarch64) TELIUM_SFU_ARTIFACT=sfu-linux-aarch64 ;;
    *)
      echo "ERROR: $machine is not an architecture releases are published for. If this box can run one anyway, set TELIUM_SFU_ARTIFACT in $CONF." >&2
      exit 1
      ;;
  esac
fi

FORCE_NOW=0
case "${1:-}" in
  --now)
    # `manual` means "do not do this on a timer", not "never do this". The
    # window, the hold and the mode are all the operator's own settings, and
    # all three yield to them in person.
    FORCE_NOW=1
    ;;
  --status)
    echo "mode:    $TELIUM_SFU_UPDATES"
    echo "pin:     ${TELIUM_SFU_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_SFU_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_SFU_UPDATE_WINDOW:-<any time>}"
    echo "unit:    $TELIUM_SFU_UNIT"
    echo "binary:  $TELIUM_SFU_BIN"
    echo "health:  $TELIUM_SFU_HEALTH_URL"
    echo "artifact: $TELIUM_SFU_ARTIFACT"
    running="$("$TELIUM_SFU_BIN" version 2>/dev/null | sed -n 's/^commit=//p')"
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

# Portable units keep both the lock and the entire update staging tree inside
# their installation prefix. Full installs retain the original /run and /var paths.
mkdir -p "$(dirname "$LOCK")" "$STATE"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another update run holds the lock; nothing to do"
  exit 0
fi

mkdir -p "$STATE"

# --------------------------------------------------------------- helpers

# Said once per pending release rather than once per tick: a journal that
# repeats the same line between midnight and the window is a journal nobody
# reads.
announce_once() {
  local marker="$STATE/$1" value="$2" message="$3"
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$value" ]; then
    printf '%s\n' "$value" > "$marker"
    echo "$message"
  fi
}

# Inside the operator's window or not at all -- the same rule as the server's
# updaters, because a maintenance window with an exception is not a maintenance
# window. A security release waits for 02:00 like everything else, and the log
# says it is waiting.
in_window() {
  if [ -z "$TELIUM_SFU_UPDATE_WINDOW" ]; then
    return 0
  fi
  # A typo in this field must not be able to hold a security release. An
  # unparseable window is treated as no window at all, loudly.
  if [[ ! "$TELIUM_SFU_UPDATE_WINDOW" =~ ^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$ ]]; then
    echo "WARNING: TELIUM_SFU_UPDATE_WINDOW=${TELIUM_SFU_UPDATE_WINDOW} is not HH:MM-HH:MM; ignoring it" >&2
    return 0
  fi
  local start end now
  start="${TELIUM_SFU_UPDATE_WINDOW%%-*}"
  end="${TELIUM_SFU_UPDATE_WINDOW##*-}"
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

# health_field KEY: read one number/word out of /health without a JSON parser
# in this script. The body is flat and its values are quoted or bare; grep for
# the key and strip. Anything unreadable prints empty, and every caller treats
# empty as "unknown" -- a probe that cannot be read must never read as a
# permission to proceed or a refusal to.
health_field() {
  curl -fsS --connect-timeout 3 --max-time 5 "$TELIUM_SFU_HEALTH_URL" 2>/dev/null \
    | tr -d ' \n' | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | head -1
}

# A pin with no stated reason is reported on every run, forever. It is still
# honoured -- overriding an operator's explicit choice because they left a
# field blank would be the software deciding it knows better -- but it does
# not get to be quiet either.
if [ -n "$TELIUM_SFU_PIN" ]; then
  if [ -n "$TELIUM_SFU_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_SFU_PIN" \
      "pinned to ${TELIUM_SFU_PIN:0:12}. Reason on file: ${TELIUM_SFU_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_SFU_PIN:0:12} with no TELIUM_SFU_PIN_REASON." >&2
    echo "ERROR: the pin is being honoured. Write down why it is there, or clear it." >&2
  fi
fi

if [ ! -x "$TELIUM_SFU_BIN" ]; then
  echo "ERROR: no relay binary at $TELIUM_SFU_BIN to ask or to replace." >&2
  exit 1
fi

# ------------------------------------------------- what this box should do
#
# Fetch, verify, parse and decide -- in the binary, not here. The script's
# whole relationship with the manifest is: run one command, read key=value
# lines, act. Exit non-zero means "I could not find out", which is a
# different thing from "stay put", and it stops the run.

plan="$STATE/plan"
if ! "$TELIUM_SFU_BIN" --config "$TELIUM_SFU_CONFIG" updates check \
    --artifact "$TELIUM_SFU_ARTIFACT" \
    ${TELIUM_SFU_PIN:+--pin "$TELIUM_SFU_PIN"} \
    ${TELIUM_SFU_MANIFEST_URL:+--manifest-url "$TELIUM_SFU_MANIFEST_URL"} \
    > "$plan"; then
  echo "ERROR: the update check failed; this relay does not know where it stands." >&2
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
    # Silence is the healthy state. Re-arm the announcements, so that if this
    # relay falls behind again it says so once, from the beginning.
    rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking" \
      "$STATE/no-artifact" "$STATE/not-published" "$STATE/check-failed"
    exit 0
    ;;
  unidentified_build)
    echo "ERROR: $TELIUM_SFU_BIN does not record which commit it came from, so it cannot" >&2
    echo "ERROR: be compared against published releases. Install a release-built binary" >&2
    echo "ERROR: (sfu/install.sh, or the sfu-v* release tarballs) before updating." >&2
    exit 1
    ;;
  not_published)
    if [ -n "$TELIUM_SFU_PIN" ]; then
      echo "ERROR: TELIUM_SFU_PIN names ${TELIUM_SFU_PIN:0:12}, which the release manifest does not list." >&2
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
if [ -n "$target_version" ]; then
  after_name="${target_version} (${after_short})"
else
  after_name="${after_short}"
fi

# A release with no installable artifact is not an error in the manifest; it
# is the ordinary state of the seed entry published before the first tagged
# release. It is also nothing this script can do.
if [ -z "$artifact_url" ]; then
  announce_once no-artifact "$after" \
    "release ${after_short} publishes no native artifact for ${TELIUM_SFU_ARTIFACT}; it ships only as a container image, and this relay stays where it is"
  exit 1
fi

# Refuse to move backwards. The manifest can be aimed at an older release only
# through a pin. The relay has no database to trap a downgrade, but it does
# have a rolling one-generation .previous, and "updating" backwards through a
# pin is a decision that deserves its own explicit reason, not a side effect.
ours_time="$("$TELIUM_SFU_BIN" version | sed -n 's/^commit_time=//p')"
if [ -n "$ours_time" ] && [ -n "$target_released_at" ] \
   && [ "$ours_time" -gt "$target_released_at" ]; then
  announce_once downgrade "$after" \
    "the pinned release ${after_short} is older than the one this relay runs (${before}); clear TELIUM_SFU_PIN if a downgrade is what you meant"
  exit 1
fi

# ------------------------------------------------- get it on disk, safely

# Already staged is already staged: the timer runs every few minutes, and a
# relay in a window or holding for a person must not re-download the same
# release on every tick. The commit marker is written only after the
# download, the digest check and the identity check have all passed, so a
# half-staged directory from a killed run simply stages again.
if [ "$(cat "$STATE/staged/commit" 2>/dev/null || true)" != "$after" ] \
   || [ ! -x "$STATE/staged/telium-sfu" ]; then
  rm -rf "$STATE/staged"
  mkdir -p "$STATE/staged"
  tarball="$STATE/staged/artifact.tar.gz"
  # -L: a GitHub release asset answers with a redirect to the CDN. The
  # redirect is unexamined on purpose -- the integrity of these bytes is a
  # property of the sha256 below, which the manifest published and which the
  # running relay verified.
  max_bytes="${artifact_size:-268435456}"
  if ! curl -fsSL --connect-timeout 15 --max-time 900 --max-filesize "$max_bytes" \
        -o "$tarball" "$artifact_url"; then
    echo "ERROR: the artifact download failed; this relay stays on ${before}." >&2
    exit 1
  fi
  # The digest is the whole of the trust chain after the manifest. Refusing
  # is the only branch.
  if ! echo "${artifact_sha256}  $tarball" | sha256sum --check --quiet >/dev/null 2>&1; then
    echo "ERROR: the downloaded artifact does not match the sha256 the manifest published; it is deleted and this relay stays on ${before}." >&2
    rm -f "$tarball"
    exit 1
  fi
  if ! tar -xzf "$tarball" -C "$STATE/staged" telium-sfu sfu.example.toml; then
    echo "ERROR: the downloaded artifact is not the archive it claimed to be; this relay stays on ${before}." >&2
    rm -f "$tarball"
    exit 1
  fi
  rm -f "$tarball"
  # The sha256 proved the bytes are the ones the release published. This
  # proves the published bytes are the release this run aimed at, and -- as a
  # side effect of asking -- that the binary so much as runs on this kernel
  # and architecture. A wrong-arch artifact now costs a log line instead of a
  # restart loop.
  staged_commit="$("$STATE/staged/telium-sfu" version 2>/dev/null | sed -n 's/^commit=//p')"
  if [ "$staged_commit" != "$after" ]; then
    echo "ERROR: the staged binary names ${staged_commit:-<nothing>}, not ${after_short}; it does not run here or is not what the release published. This relay stays on ${before}." >&2
    rm -rf "$STATE/staged"
    exit 1
  fi
  echo "$after" > "$STATE/staged/commit"
  echo "staged ${after_short}: downloaded, digest-checked, and it names itself ${after_short}"
  if [ -n "$notes" ]; then
    echo "upgrade notes: ${notes}"
  fi
fi

# The staged binary audits the live config before anything restarts. It opens
# no database and spawns no LiveKit, so this is free of side effects; what it
# buys is that a configuration the new release considers invalid stops the
# update here -- where the operator still has a running relay -- instead of at
# ExecStart, where the unit would refuse to start.
if ! "$STATE/staged/telium-sfu" --config "$TELIUM_SFU_CONFIG" check > /dev/null; then
  announce_once check-failed "$after" \
    "the staged release ${after_short} fails \`telium-sfu check\` against this box's configuration; it is waiting. Run the check to read why, then run: $SELF --now"
  exit 0
fi

# ------------------------------------------------------ who says it's time

# A release can say that it needs a person before it is taken. The relay
# stops here, staged and waiting, and --now is the person.
if [ "$breaking" = "true" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-breaking "$after" \
    "this release says it needs a person before it is taken${notes:+ -- ${notes}}; it is staged and waiting. Run: $SELF --now"
  exit 0
fi

if [ "$TELIUM_SFU_UPDATES" != "automatic" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-manual "$after" \
    "a new release is staged and TELIUM_SFU_UPDATES is ${TELIUM_SFU_UPDATES}; run: $SELF --now"
  exit 0
fi

if ! in_window && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-window "$after" \
    "a new release is staged; installing it when the window opens (${TELIUM_SFU_UPDATE_WINDOW})"
  exit 0
fi

# --------------------------------------------------- the move, in order
#
# 1. A best-effort copy of the usage ledger -- the only state the binary owns.
# 2. The drain: SIGUSR1 makes the running relay refuse new joins while live
#    calls finish. Wait inside the operator's ceiling, then go anyway.
# 3. The swap: three steps inside one directory, the last of which is a
#    rename(2), so there is no moment when the path exists but is partial.
# 4. A restart, a wait that watches systemd, and one rollback attempt.

usage_ledger="${TELIUM_SFU_USAGE_LEDGER:-$(dirname "$TELIUM_SFU_CONFIG")/livekit/usage.json}"
if [ -f "$usage_ledger" ]; then
  if cp -a "$usage_ledger" "$STATE/usage.json.pre-update"; then
    echo "backup: ${STATE}/usage.json.pre-update"
  else
    echo "WARNING: could not copy the usage ledger; proceeding -- the ledger is an estimate, not a record of calls." >&2
  fi
fi

# The drain. The relay auto-resumes after updates.drain_max_secs even if this
# script dies mid-wait, which is why the wait here is bounded by the
# operator's TELIUM_SFU_DRAIN_TIMEOUT rather than unbounded: the two settings
# disagree by design, the relay's is the safety net and this one is the plan.
if systemctl kill --signal=SIGUSR1 --kill-whom=main "$TELIUM_SFU_UNIT" 2>/dev/null; then
  echo "drain requested; waiting up to ${TELIUM_SFU_DRAIN_TIMEOUT}s for rooms to empty"
  for _ in $(seq 1 "$TELIUM_SFU_DRAIN_TIMEOUT"); do
    rooms="$(health_field rooms)"
    accepting="$(health_field accepting)"
    # truthy JSON bare word; anything unreadable is treated as "keep waiting
    # for the ceiling", never as a reason to skip ahead.
    if [ "$accepting" = "false" ] && [ "$rooms" = "0" ]; then
      echo "drained: no rooms remain"
      break
    fi
    sleep 1
  done
  if [ "${rooms:-}" != "0" ]; then
    echo "proceeding with ${rooms:-unknown} room(s) still active; live calls will drop and clients will rejoin"
  fi
else
  echo "WARNING: could not signal ${TELIUM_SFU_UNIT} (is it running?); updating without a drain" >&2
fi

install -m755 "$STATE/staged/telium-sfu" "$(dirname "$TELIUM_SFU_BIN")/.telium-sfu.incoming"
# One generation, kept for the ten-second kind of rollback: an operator who
# realises mid-restart that this release is wrong can put it back by hand.
cp -a "$TELIUM_SFU_BIN" "${TELIUM_SFU_BIN}.previous"
mv -f "$(dirname "$TELIUM_SFU_BIN")/.telium-sfu.incoming" "$TELIUM_SFU_BIN"

# The reference config, never the live one. Every key the relay reads has a
# default compiled in, so a release cannot break an sfu.toml by adding to it.
example="$(dirname "$TELIUM_SFU_CONFIG")/sfu.example.toml"
if ! cmp -s "$STATE/staged/sfu.example.toml" "$example"; then
  install -m644 "$STATE/staged/sfu.example.toml" "$example" 2>/dev/null || true
  echo "sfu.example.toml updated; diff it against sfu.toml to see what this release added"
fi

echo "installed ${before} -> ${after_name}; restarting ${TELIUM_SFU_UNIT}"
# Restart itself can fail before systemd reports an active unit. Do not let
# set -e bypass rollback, which exists precisely for a non-starting release.
if ! systemctl restart "$TELIUM_SFU_UNIT"; then
  echo "WARNING: restart failed; checking readiness before rollback" >&2
fi

# An active unit can still have a broken LiveKit engine. Require the relay's
# own health probe before declaring the new release successful.
up=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$TELIUM_SFU_UNIT"      && [ "$(health_field ok)" = "true" ]; then
    up=1
    break
  fi
  sleep 1
done

if [ "$up" -eq 0 ]; then
  # The difference from the server's script, and the reason it is safe here:
  # the relay keeps no database, so the previous binary cannot be locked out
  # of anything. A relay that will not start is strictly worse than a relay on
  # yesterday's release, so put yesterday back -- once. If the previous
  # binary also refuses to start, that is a person's problem, and the log now
  # says exactly where to look.
  echo "WARNING: ${TELIUM_SFU_UNIT} did not come back up; rolling back to the previous release" >&2
  if [ -x "${TELIUM_SFU_BIN}.previous" ]; then
    install -m755 "${TELIUM_SFU_BIN}.previous" "$(dirname "$TELIUM_SFU_BIN")/.telium-sfu.incoming"
    mv -f "$(dirname "$TELIUM_SFU_BIN")/.telium-sfu.incoming" "$TELIUM_SFU_BIN"
    if ! systemctl restart "$TELIUM_SFU_UNIT"; then
      echo "WARNING: rollback restart failed; checking readiness" >&2
    fi
    up=0
    for _ in $(seq 1 30); do
      if systemctl is-active --quiet "$TELIUM_SFU_UNIT"          && [ "$(health_field ok)" = "true" ]; then
        up=1
        break
      fi
      sleep 1
    done
    if [ "$up" -eq 1 ]; then
      echo "rolled back to ${before}; this release did not start on this box. Read journalctl -u ${TELIUM_SFU_UNIT} before staging it again." >&2
      rm -rf "$STATE/staged"
      exit 1
    fi
  fi
  echo "ERROR: ${TELIUM_SFU_UNIT} will not start, not even on the previous release." >&2
  echo "ERROR: read journalctl -u ${TELIUM_SFU_UNIT}; the staged artifact is kept in $STATE/staged." >&2
  exit 1
fi

running="$("$TELIUM_SFU_BIN" version | sed -n 's/^commit=//p')"
if [ "$running" != "$after" ]; then
  echo "WARNING: the unit is active but the binary on disk names ${running:-<unknown>}; it will be running after the next restart." >&2
fi

rm -rf "$STATE/staged"
rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking" \
  "$STATE/no-artifact" "$STATE/not-published" "$STATE/check-failed" "$STATE/downgrade"

echo "deployed ${before} -> ${after_short}"
