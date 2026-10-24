#!/usr/bin/env bash
#
# Ask the registry whether the current release still means what it meant a
# minute ago, and act on the answer.
#
# This is the entire deploy mechanism. It runs on the box, on a timer, and
# reaches out to GitHub rather than being reached from it -- which is why
# nothing in GitHub needs a key to this machine.
#
# It does four things, in this order, and the order matters:
#
#   1. Works out which image this box should be running -- the channel, or the
#      digest pinned in update.conf.
#   2. Pulls it, and stops here if nothing moved. Silence is the healthy state.
#   3. Reconciles the configuration files that ship with a release against the
#      ones on this box, which is the half this script used to skip entirely.
#   4. Restarts the server, inside the operator's window if they set one.
#
# On step 3, at length, because it is the part where being wrong is expensive:
#
# A release can change compose.yml -- a new volume, a tightened security
# option, a port that moved. Before this, it could not deliver that change to a
# running box: only the image was pulled, so half of what a release said was
# silently dropped, and a deploy that cannot deliver half a release is not an
# automatic update, it is an automatic image swap wearing the name.
#
# The obvious fix is to copy the new file over the old one, and it is wrong.
# /opt/telium/compose.yml is also the operator's file: it is where the tunnel
# address lives, where the volume layout lives, where whatever local adjustment
# this particular machine needed lives. Overwriting that on a Tuesday morning
# because a release touched an unrelated line would be a far worse bug than the
# one being fixed, and it would be the kind of bug that eats a box at 3am with
# nobody watching.
#
# So this keeps a third copy: .baseline/compose.yml, which is what the *last
# release shipped*. Three files, and the comparison between them answers the
# question cleanly:
#
#   shipped == baseline        the release did not touch it. Do nothing, say
#                              nothing, whatever the local file looks like.
#   local == baseline          the release changed it and the operator never
#                              did. Apply it, and say what moved.
#   both changed               a genuine conflict. Change nothing, write the
#                              new file alongside as compose.yml.dist, and
#                              report it on every run until a human resolves
#                              it with `update.sh --config-resolved`.
#
# The conflict case still deploys the image. That is deliberate: gating a
# security fix on an unmerged config hunk would hold the fix hostage to
# paperwork, and the merge is usually three lines. What it must not do is go
# quiet, so it does not -- the warning repeats forever, which is the correct
# amount for a thing that is genuinely still wrong.
#
# telium.toml is never written by this script under any circumstances. It is
# the operator's config, every key in it has a default in the binary, and a
# release therefore never *needs* it to change. What ships instead is the
# reference file -- telium.example.toml, dropped next to it -- so `diff` is
# available to anyone who wants to see what a release added.

set -euo pipefail

cd /opt/telium

BASELINE=/opt/telium/.baseline
STATE=/opt/telium/.state
PIN_OVERRIDE=/opt/telium/compose.pin.yml

# Defaults, then whatever the operator said. A box installed before this file
# existed has no update.conf and gets exactly the behaviour it had: automatic,
# unpinned, no window.
TELIUM_UPDATES=automatic
TELIUM_PIN=
TELIUM_PIN_REASON=
TELIUM_UPDATE_WINDOW=
TELIUM_MANAGE_COMPOSE=yes
if [ -r /opt/telium/update.conf ]; then
  # shellcheck source=/dev/null
  . /opt/telium/update.conf
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
    echo "mode:    $TELIUM_UPDATES"
    echo "pin:     ${TELIUM_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_UPDATE_WINDOW:-<any time>}"
    echo "compose: $TELIUM_MANAGE_COMPOSE"
    if [ -f "$STATE/compose.conflict" ]; then
      echo "conflict: compose.yml.dist is waiting to be merged"
    fi
    # The one state a box can be in that neither the mode nor the window
    # explains: updates are on, the window is open, and the deploy stopped
    # anyway because the release itself asked for a person. Without this line
    # that box looks like it is simply up to date.
    if [ -f "$STATE/waiting-breaking" ]; then
      echo "held:    a release needing a person is pulled and waiting; --now takes it"
    fi
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: update.sh [--now | --config-resolved | --status]" >&2
    exit 2
    ;;
esac

mkdir -p "$BASELINE" "$STATE"

# --------------------------------------------------------------- helpers
#
# Defined here rather than beside their first use, because bash resolves a
# function name when the line runs and the pin report below is the earliest
# caller.

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


# --------------------------------------------------------------- the pin

# A pin is a compose override rather than an edit to compose.yml, so that
# clearing one line of update.conf is all it takes to follow the channel again
# and so that the baseline comparison above is never confused by it.
if [ -n "$TELIUM_PIN" ]; then
  case "$TELIUM_PIN" in
    # A bare digest is completed from whatever repository compose.yml already
    # names, so an operator pulling from their own registry can pin by digest
    # without repeating the address. Shortest-suffix trims, not longest: a
    # registry with a port in its name has a colon of its own, and `%%:*` would
    # eat the whole path back to the hostname.
    sha256:*)
      channel_image="$(docker compose -f compose.yml config --images server)"
      repository="${channel_image%@*}"
      pinned_image="${repository%:*}@${TELIUM_PIN}"
      ;;
    *) pinned_image="$TELIUM_PIN" ;;
  esac
  cat > "$PIN_OVERRIDE" <<EOF
# Written by update.sh from TELIUM_PIN in update.conf. Edit that, not this.
services:
  server:
    image: ${pinned_image}
EOF
  COMPOSE=(docker compose -f compose.yml -f "$PIN_OVERRIDE")
else
  rm -f "$PIN_OVERRIDE"
  COMPOSE=(docker compose -f compose.yml)
fi

# Named, not the first line of the list: there are two services and only one of
# them is ours to move.
IMAGE="$("${COMPOSE[@]}" config --images server)"

# ------------------------------------------------- is there anything new

# The id of what we have, or nothing on the very first run.
before="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"

# A pull with nothing to fetch is one manifest request. This is cheap enough to
# do every minute and it is the only network traffic this script normally makes.
"${COMPOSE[@]}" pull --quiet server

after="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

# A pin with no stated reason is reported on every run, forever. It is still
# honoured -- overriding an operator's explicit choice because they left a field
# blank would be the software deciding it knows better, which is not a thing
# this script gets to do -- but it does not get to be quiet either.
#
# Note what is deliberately *not* here: this does not pull the channel image to
# see how far the pin has drifted. That would put a second full image on the
# disk of every pinned box to learn a fact the server itself already knows in
# far more detail, from the release manifest, with dates and security flags
# attached. Keeping a pin an active decision is that check's job; saying the pin
# exists is this one's.
if [ -n "$TELIUM_PIN" ]; then
  if [ -n "$TELIUM_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_PIN" \
      "pinned to ${TELIUM_PIN}. Reason on file: ${TELIUM_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_PIN} with no TELIUM_PIN_REASON." >&2
    echo "ERROR: the pin is being honoured. Write down why it is there, or clear it." >&2
  fi
fi

# A conflict does not expire. Repeating this on every run is the friction, and
# the friction is the feature: a merge that nobody is ever reminded of is a
# merge that never happens.
if [ -f "$STATE/compose.conflict" ]; then
  echo "WARNING: this release's compose.yml has not been applied -- your copy has local edits." >&2
  echo "WARNING: merge compose.yml.dist into compose.yml, then run: /opt/telium/update.sh --config-resolved" >&2
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
  docker cp "$cid:/usr/share/telium/deploy/compose.yml" "$shipped/compose.yml" >/dev/null 2>&1 || true
  docker cp "$cid:/usr/share/telium/deploy/telium.example.toml" "$shipped/telium.example.toml" >/dev/null 2>&1 || true
  docker rm -f "$cid" >/dev/null 2>&1 || true
fi

if [ -f "$shipped/compose.yml" ] && [ "$TELIUM_MANAGE_COMPOSE" = "yes" ]; then
  if [ ! -f "$BASELINE/compose.yml" ]; then
    # First run under this scheme. There is no way to tell an operator's edits
    # from an untouched file without a baseline to compare against, so record
    # one and touch nothing. The next release that changes compose.yml gets the
    # three-way comparison it needs; this one correctly does nothing.
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
    echo "WARNING: then run: /opt/telium/update.sh --config-resolved" >&2
  fi
fi

# The reference config, never the live one. Every key the server reads has a
# default compiled in, so a release cannot break a telium.toml by adding to it
# -- which is exactly why this can be a `diff` an operator reads when they feel
# like it rather than a merge they are made to do.
if [ -f "$shipped/telium.example.toml" ] && ! same "$shipped/telium.example.toml" telium.example.toml; then
  cp "$shipped/telium.example.toml" telium.example.toml
  echo "telium.example.toml updated; diff it against telium.toml to see what this release added"
fi

# ------------------------------------------- does this one need a person
#
# A release can say that it needs a human before it is taken: a config key that
# changed meaning, a migration that rewrites a large table, a default that
# flipped. The person writing the change is the only one who knows, so they say
# so in a trailer on the commit (`Breaking-change: yes`, `Upgrade-notes: ...`)
# and the publishing workflow puts it on the image as a label.
#
# Read from the image rather than fetched from anywhere, which matters more
# than it sounds. The image is already on this disk, so this needs no network
# call, no JSON parser and no second source of truth that can be unreachable at
# the moment it counts. Nothing here can fail in a way that blocks a release:
# an image with no labels -- every image published before this existed -- reads
# as an ordinary release and proceeds exactly as it did before.
#
# What it does is stop the timer. An unattended box takes every ordinary
# release on its own and waits for a person at the ones that need one, which is
# the entire distinction: automatic updates are a good default precisely
# because they are boring, and a release that is not boring should not be one.
# `--now` takes it, and says out loud that somebody decided to.
#
# `index` against an image that carries no labels at all yields the literal
# string `<no value>` rather than an empty one, so both reads go through a
# filter that turns it back into nothing. Without it, every release published
# before these labels existed would print `release notes: <no value>`.
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
    "this release says it needs a person before it is taken${notes:+ -- ${notes}}; it is pulled and waiting. Read docs/production.md and the release notes, then run /opt/telium/update.sh --now"
  exit 0
fi

# ------------------------------------------------------ restart, or wait


if [ "$TELIUM_UPDATES" != "automatic" ] && [ "$FORCE_NOW" -eq 0 ]; then
  announce_once waiting-manual "$after" \
    "a new release is available and TELIUM_UPDATES is ${TELIUM_UPDATES}; run /opt/telium/update.sh --now to take it"
  exit 0
fi

if ! in_window; then
  announce_once waiting-window "$after" \
    "a new release is available; holding it until the update window ${TELIUM_UPDATE_WINDOW}"
  exit 0
fi

"${COMPOSE[@]}" up -d server
rm -f "$STATE/waiting-manual" "$STATE/waiting-window" "$STATE/waiting-breaking"

# Keep a week of previous images. They are what a rollback uses -- there is no
# automatic one, by choice, but `docker compose` against an older digest is a
# ten second fix and only if the layers are still here.
docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true

echo "deployed ${after}"
