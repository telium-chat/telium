#!/usr/bin/env bash
#
# The standalone kit's updater: ask the registry whether the channel moved,
# and if it did, move with it. Enabled by install.sh; runs every minute.
#
# Same questions, same answers, same config file as the tunnel kit's updater
# (deploy/update.sh) -- update.conf's four fields mean the same thing to both,
# because "automatic or manual, pinned to what, restarted when" is one set of
# decisions regardless of which kit answers them. What this one does not do is
# reconcile shipped config files: the standalone kit's compose.yml, Caddyfile
# and .env are fetched from the repository release by you, and a release that
# changes the kit says so in its notes. The image carries reference copies of
# everything at /usr/share/telium/deploy/standalone/ for the diff.
#
# It does three things, in this order:
#
#   1. Works out which images this box should be running -- the channel tags,
#      or the pin from update.conf, applied as a compose override.
#   2. Pulls them, and stops here if nothing moved. Silence is the healthy
#      state.
#   3. Restarts whatever moved, inside the operator's window if they set one,
#      holding a release that marks itself breaking until `--now`.
#
# `docker compose` here means "with the profiles in .env", so the SFU's image
# is pulled and restarted by the same run that moves the server -- one update
# story for the whole project.

set -euo pipefail

cd /opt/telium

STATE=/opt/telium/.state
PIN_OVERRIDE=/opt/telium/compose.pin.yml

# Defaults, then whatever the operator said.
TELIUM_UPDATES=automatic
TELIUM_PIN=
TELIUM_PIN_REASON=
TELIUM_UPDATE_WINDOW=
if [ -r /opt/telium/update.conf ]; then
  # shellcheck source=/dev/null
  . /opt/telium/update.conf
fi

FORCE_NOW=0
case "${1:-}" in
  --now)  FORCE_NOW=1 ;;
  --status)
    echo "mode:    $TELIUM_UPDATES"
    echo "pin:     ${TELIUM_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_UPDATE_WINDOW:-<any time>}"
    if [ -f "$STATE/waiting-breaking" ]; then
      echo "held:    a release needing a person is pulled and waiting; --now takes it"
    fi
    exit 0
    ;;
  "") ;;
  *) echo "usage: update.sh [--now | --status]" >&2; exit 2 ;;
esac

mkdir -p "$STATE"

announce_once() {
  local marker="$STATE/$1" value="$2" message="$3"
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$value" ]; then
    printf '%s\n' "$value" > "$marker"
    echo "$message"
  fi
}

# Inside the operator's window or not at all. An unparseable window is treated
# as no window, loudly: a typo must not be able to quietly stop security fixes.
in_window() {
  if [ -z "$TELIUM_UPDATE_WINDOW" ]; then return 0; fi
  if [[ ! "$TELIUM_UPDATE_WINDOW" =~ ^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$ ]]; then
    echo "WARNING: TELIUM_UPDATE_WINDOW=${TELIUM_UPDATE_WINDOW} is not HH:MM-HH:MM; ignoring it" >&2
    return 0
  fi
  local start end now
  start="${TELIUM_UPDATE_WINDOW%%-*}"; end="${TELIUM_UPDATE_WINDOW##*-}"
  now="$(date +%H%M)"; start="${start/:/}"; end="${end/:/}"
  if [ "$((10#$start))" -le "$((10#$end))" ]; then
    [ "$((10#$now))" -ge "$((10#$start))" ] && [ "$((10#$now))" -lt "$((10#$end))" ]
  else
    [ "$((10#$now))" -ge "$((10#$start))" ] || [ "$((10#$now))" -lt "$((10#$end))" ]
  fi
}

# The pin is a compose override, so clearing one line of update.conf is all it
# takes to follow the channel again.
if [ -n "$TELIUM_PIN" ]; then
  case "$TELIUM_PIN" in
    sha256:*)
      channel_image="$(docker compose config --images server)"
      pinned_image="${channel_image%@*}@${TELIUM_PIN}"
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

before="$("${COMPOSE[@]}" config --images | while read -r img; do
  docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || true
done)"

"${COMPOSE[@]}" pull --quiet

after="$("${COMPOSE[@]}" config --images | while read -r img; do
  docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || true
done)"

if [ -n "$TELIUM_PIN" ]; then
  if [ -n "$TELIUM_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_PIN" \
      "pinned to ${TELIUM_PIN}. Reason on file: ${TELIUM_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_PIN} with no TELIUM_PIN_REASON." >&2
    echo "ERROR: the pin is being honoured. Write down why it is there, or clear it." >&2
  fi
fi

if [ "$before" = "$after" ]; then
  exit 0
fi

# A release that says it needs a person gets one. The image stays pulled --
# gating a fix on paperwork twice would be absurd -- but nothing restarts
# until the operator says so, in person, once.
server_image="$("${COMPOSE[@]}" config --images server)"
breaking="$(docker image inspect --format '{{ index .Config.Labels "chat.telium.release.breaking" }}' "$server_image" 2>/dev/null || true)"
if [ "$breaking" = "true" ] && [ "$FORCE_NOW" -ne 1 ] && [ ! -f "$STATE/waiting-breaking" ]; then
  mkdir -p "$STATE"
  echo "held" > "$STATE/waiting-breaking"
  echo "this release is marked breaking and is waiting for a person; take it with: /opt/telium/update.sh --now"
  exit 0
fi
rm -f "$STATE/waiting-breaking"

if ! in_window; then
  echo "image moved but $(date +%H:%M) is outside TELIUM_UPDATE_WINDOW=${TELIUM_UPDATE_WINDOW}; waiting"
  exit 0
fi

echo "images moved; applying"
"${COMPOSE[@]}" up -d --remove-orphans

# Dangling layers from the replaced images only; nothing tagged is touched.
docker image prune -f >/dev/null
