#!/usr/bin/env bash
#
# The SFU's counterpart to update.sh: ask the registry whether the current
# release still means what it meant a minute ago, and act on the answer.
#
# Same shape, same order, same reasons -- the container path's properties
# belong to no particular image:
#
#   1. Works out which image this relay should be running -- the channel, or
#      the digest pinned in update-sfu.conf.
#   2. Pulls it, and stops here if nothing moved. Silence is the healthy state.
#   3. Reconciles the configuration files that ship with a release against the
#      ones on this box, three-way against a .baseline copy.
#   4. Drains the relay (SIGUSR1: refuse new joins, let calls finish), then
#      recreates it, inside the operator's window if they set one.
#
# On step 3, the short version of update.sh's long argument: compose.sfu.yml
# is both the release's file and the operator's file, and overwriting the
# operator's copy on a Tuesday morning because a release touched an unrelated
# line is a bug that eats a box at 3am. So the shipped file, the local file
# and a .baseline of what the last release shipped are compared, and only a
# locally-unedited file is ever replaced. A genuine conflict writes
# compose.yml.dist and reports itself on every run until a human resolves it
# with `update-sfu.sh --config-resolved` -- the image still deploys, because
# gating a security fix on an unmerged config hunk holds the fix hostage to
# paperwork.
#
# sfu.toml is never written by this script under any circumstances. The
# reference config ships alongside, to `diff` when you feel like it.
#
# The drain is the one step the server's script has no equivalent of, because
# the server has no equivalent of a live call. SIGUSR1 puts the running relay
# into its drain state -- admission refuses new joins, /health reports
# accepting:false so the directory stops routing to it -- and this script
# waits within TELIUM_SFU_DRAIN_TIMEOUT for rooms to empty before recreating
# the container. The relay auto-resumes accepting after its own
# updates.drain_max_secs if this script dies mid-wait; the two ceilings
# disagree by design, the relay's is the safety net and this one is the plan.

set -euo pipefail

cd /opt/telium-sfu

BASELINE=/opt/telium-sfu/.baseline
STATE=/opt/telium-sfu/.state
PIN_OVERRIDE=/opt/telium-sfu/compose.pin.yml

# Defaults, then whatever the operator said. A box installed before this file
# existed has no update-sfu.conf and gets exactly the behaviour it had:
# automatic, unpinned, no window.
TELIUM_SFU_UPDATES=automatic
TELIUM_SFU_PIN=
TELIUM_SFU_PIN_REASON=
TELIUM_SFU_UPDATE_WINDOW=
TELIUM_SFU_MANAGE_COMPOSE=yes
TELIUM_SFU_HEALTH_URL=http://127.0.0.1:7890/health
TELIUM_SFU_DRAIN_TIMEOUT=900
if [ -r /opt/telium-sfu/update-sfu.conf ]; then
  # shellcheck source=/dev/null
  . /opt/telium-sfu/update-sfu.conf
fi

FORCE_NOW=0
case "${1:-}" in
  --now)
    # `manual` means "do not do this on a timer", not "never do this". This is
    # the operator saying now.
    FORCE_NOW=1
    ;;
  --config-resolved)
    # The operator has merged compose.yml.dist into their compose.yml by hand.
    # Adopting the shipped file as the new baseline is what makes the conflict
    # stop repeating -- and it is a human saying so, which is the only thing
    # that can honestly say it.
    if [ ! -f compose.yml.dist ]; then
      echo "no compose.yml.dist to resolve" >&2
      exit 1
    fi
    mkdir -p "$BASELINE"
    cp compose.yml.dist "$BASELINE/compose.yml"
    rm -f compose.yml.dist "$STATE/compose.conflict"
    echo "config conflict resolved: baseline is now this release's compose.yml"
    exit 0
    ;;
  --status)
    echo "mode:    $TELIUM_SFU_UPDATES"
    echo "pin:     ${TELIUM_SFU_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_SFU_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_SFU_UPDATE_WINDOW:-<any time>}"
    echo "compose: $TELIUM_SFU_MANAGE_COMPOSE"
    if [ -f "$STATE/compose.conflict" ]; then
      echo "conflict: compose.yml.dist is waiting to be merged"
    fi
    if [ -f "$STATE/waiting-breaking" ]; then
      echo "held:    a release needing a person is pulled and waiting; --now takes it"
    fi
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: update-sfu.sh [--now | --config-resolved | --status]" >&2
    exit 2
    ;;
esac

mkdir -p "$BASELINE" "$STATE"

# --------------------------------------------------------------- helpers

same() { [ -f "$1" ] && [ -f "$2" ] && cmp -s "$1" "$2"; }

# Said once per pending image rather than once per minute. A journal that
# repeats the same line 480 times between midnight and the window is a journal
# nobody reads.
announce_once() {
  local marker="$STATE/$1" value="$2" message="$3"
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$value" ]; then
    printf '%s\n' "$value" > "$marker"
    echo "$message"
  fi
}

# Inside the operator's window or not at all. A maintenance window with an
# exception for urgent things is not a maintenance window, so there is no
# exception here -- a security release waits for 02:00 like everything else,
# and the log says it is waiting.
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

# health_field KEY: read one value out of the relay's /health without a JSON
# parser in this script. Anything unreadable prints empty, and every caller
# treats empty as "unknown" -- a probe that cannot be read must never read as
# a permission to proceed.
health_field() {
  curl -fsS --connect-timeout 3 --max-time 5 "$TELIUM_SFU_HEALTH_URL" 2>/dev/null \
    | tr -d ' \n' | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | head -1
}

# --------------------------------------------------------------- the pin

# A pin is a compose override rather than an edit to compose.yml, so that
# clearing one line of update-sfu.conf is all it takes to follow the channel
# again and so that the baseline comparison is never confused by it.
if [ -n "$TELIUM_SFU_PIN" ]; then
  case "$TELIUM_SFU_PIN" in
    # A bare digest is completed from whatever repository compose.yml already
    # names. Shortest-suffix trims, not longest: a registry with a port in its
    # name has a colon of its own.
    sha256:*)
      channel_image="$(docker compose -f compose.yml config --images)"
      repository="${channel_image%@*}"
      pinned_image="${repository%:*}@${TELIUM_SFU_PIN}"
      ;;
    *) pinned_image="$TELIUM_SFU_PIN" ;;
  esac
  cat > "$PIN_OVERRIDE" <<EOF
# Written by update-sfu.sh from TELIUM_SFU_PIN in update-sfu.conf. Edit that, not this.
services:
  sfu:
    image: ${pinned_image}
EOF
  COMPOSE=(docker compose -f compose.yml -f "$PIN_OVERRIDE")
else
  rm -f "$PIN_OVERRIDE"
  COMPOSE=(docker compose -f compose.yml)
fi

# Named, not assumed: there is exactly one service here today, and naming it
# is what keeps that true if there are ever two.
IMAGE="$("${COMPOSE[@]}" config --images)"

# ------------------------------------------------- is there anything new

# Compare the image *running in the container* with the desired image.
# Comparing the local cache before and after pull incorrectly loses updates
# deferred for a maintenance window, manual approval, or a breaking release:
# subsequent runs see a warm cache and never reach the deployment path.
container="$("${COMPOSE[@]}" ps -q sfu 2>/dev/null || true)"
before=""
if [ -n "$container" ]; then
  before="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
fi

# Pull regardless of whether a maintenance window is open: the pending image
# can be cached early, but only the running container decides if it was applied.
"${COMPOSE[@]}" pull --quiet sfu
after="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

# A pin with no stated reason is reported on every run, forever. It is still
# honoured -- overriding an operator's explicit choice would be the software
# deciding it knows better -- but it does not get to be quiet either.
if [ -n "$TELIUM_SFU_PIN" ]; then
  if [ -n "$TELIUM_SFU_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_SFU_PIN" \
      "pinned to ${TELIUM_SFU_PIN}. Reason on file: ${TELIUM_SFU_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_SFU_PIN} with no TELIUM_SFU_PIN_REASON." >&2
    echo "ERROR: the pin is being honoured. Write down why it is there, or clear it." >&2
  fi
fi

# A conflict does not expire. Repeating this on every run is the friction, and
# the friction is the feature: a merge that nobody is ever reminded of is a
# merge that never happens.
if [ -f "$STATE/compose.conflict" ]; then
  echo "WARNING: this release's compose.yml has not been applied -- your copy has local edits." >&2
  echo "WARNING: merge compose.yml.dist into compose.yml, then run: /opt/telium-sfu/update-sfu.sh --config-resolved" >&2
fi

if [ "$before" = "$after" ]; then
  exit 0
fi

echo "image moved: ${before:-<none>} -> ${after}"

# -------------------------------------------- what the release ships with

# Pulled out of the image with `docker create`, which unpacks nothing and runs
# nothing -- the container is never started. An image from before this existed
# simply has no such paths, and the copy fails harmlessly.
shipped="$(mktemp -d)"
trap 'rm -rf "$shipped"' EXIT
cid="$(docker create "$IMAGE" 2>/dev/null || true)"
if [ -n "$cid" ]; then
  docker cp "$cid:/usr/share/telium/deploy/compose.sfu.yml" "$shipped/compose.yml" >/dev/null 2>&1 || true
  docker cp "$cid:/usr/share/telium/deploy/sfu.example.toml" "$shipped/sfu.example.toml" >/dev/null 2>&1 || true
  docker rm -f "$cid" >/dev/null 2>&1 || true
fi

if [ -f "$shipped/compose.yml" ] && [ "$TELIUM_SFU_MANAGE_COMPOSE" = "yes" ]; then
  if [ ! -f "$BASELINE/compose.yml" ]; then
    # First run under this scheme. There is no way to tell an operator's edits
    # from an untouched file without a baseline to compare against, so record
    # one and touch nothing.
    cp "$shipped/compose.yml" "$BASELINE/compose.yml"
    echo "recorded the shipped compose.yml as the baseline; your copy was not touched"
  elif same "$shipped/compose.yml" "$BASELINE/compose.yml"; then
    : # The release did not change it. Nothing to say.
  elif same compose.yml "$BASELINE/compose.yml"; then
    cp "$shipped/compose.yml" compose.yml
    cp "$shipped/compose.yml" "$BASELINE/compose.yml"
    rm -f compose.yml.dist "$STATE/compose.conflict"
    echo "applied this release's compose.yml (your copy had no local edits)"
  else
    cp "$shipped/compose.yml" compose.yml.dist
    date -u +'%Y-%m-%dT%H:%M:%SZ' > "$STATE/compose.conflict"
    echo "WARNING: this release changes compose.yml and your copy has local edits." >&2
    echo "WARNING: nothing was overwritten. The new file is compose.yml.dist; diff it, merge it," >&2
    echo "WARNING: then run: /opt/telium-sfu/update-sfu.sh --config-resolved" >&2
  fi
fi

# The reference config, never the live one.
if [ -f "$shipped/sfu.example.toml" ] && ! same "$shipped/sfu.example.toml" sfu.example.toml; then
  cp "$shipped/sfu.example.toml" sfu.example.toml
  echo "sfu.example.toml updated; diff it against sfu.toml to see what this release added"
fi

# ------------------------------------------- does this one need a person
#
# A release can say that it needs a human before it is taken. Read from the
# image rather than fetched from anywhere: the image is already on this disk,
# so this needs no network call and no second source of truth. An image with
# no labels -- every image published before this existed -- reads as an
# ordinary release and proceeds. `index` against a label-less image yields the
# literal string `<no value>`, so both reads go through a filter that turns
# that back into nothing.
label() {
  local v
  v="$(docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$IMAGE" 2>/dev/null || true)"
  if [ "$v" = "<no value>" ]; then
    v=""
  fi
  printf '%s' "$v"
}

breaking="$(label chat.telium.release.breaking)"
notes="$(label chat.telium.release.notes)"

if [ -n "$notes" ]; then
  echo "release notes: ${notes}"
fi

if [ "$breaking" = "true" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-breaking "$after" \
    "this release says it needs a person before it is taken${notes:+ -- ${notes}}; it is pulled and waiting. Read the release notes, then run /opt/telium-sfu/update-sfu.sh --now"
  exit 0
fi

# ------------------------------------------------------ restart, or wait

if [ "$TELIUM_SFU_UPDATES" != "automatic" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-manual "$after" \
    "a new release is available and TELIUM_SFU_UPDATES is ${TELIUM_SFU_UPDATES}; run /opt/telium-sfu/update-sfu.sh --now to take it"
  exit 0
fi

if ! in_window && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-window "$after" \
    "a new release is available; holding it until the update window ${TELIUM_SFU_UPDATE_WINDOW}"
  exit 0
fi

# The drain: refuse new joins, let live calls finish, within the operator's
# ceiling. `docker kill --signal` targets PID 1 without stopping the
# container; the relay answers by flipping admission and /health. A relay
# that never shows draining (an image too old to understand the signal, or a
# relay already down) is drained by the ceiling timing out, which is the
# honest outcome: proceed with calls active and say so.
if [ -n "$container" ]; then
  if docker kill --signal=USR1 "$container" >/dev/null 2>&1; then
    echo "drain requested; waiting up to ${TELIUM_SFU_DRAIN_TIMEOUT}s for rooms to empty"
    rooms=""
    for _ in $(seq 1 "$TELIUM_SFU_DRAIN_TIMEOUT"); do
      rooms="$(health_field rooms)"
      accepting="$(health_field accepting)"
      # Anything unreadable keeps waiting for the ceiling; it never reads as
      # a reason to skip ahead or as a refusal to proceed.
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
    echo "WARNING: could not signal the running relay; updating without a drain" >&2
  fi
else
  echo "relay is not running; nothing to drain"
fi

"${COMPOSE[@]}" up -d sfu
rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking"

# Keep a week of previous images. They are what a rollback uses -- there is no
# automatic one, by choice, but `docker compose` against an older digest is a
# ten second fix and only if the layers are still here.
docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true

echo "deployed ${after}"
