#!/bin/sh
#
# The Compose kit's updater logic. Ships inside the server image at
# /usr/share/telium/deploy/compose/update.sh; the `updater` service in
# deploy/compose/compose.yml copies it out of the server container before
# every run, so each release carries its own update logic and the updater
# container never has to replace itself.
#
# Runs inside the updater container (Alpine, docker CLI + compose plugin, no
# bash), with:
#
#   /var/run/docker.sock   the host's Docker
#   /project               the directory holding compose.yml and .env, read-only
#   /state                 a volume of its own, for what it remembers
#
#   telium-update            one pass: pull, and restart whatever moved
#   telium-update --now      the same, taking a held release, with no notice
#   telium-update --status   what it is set to do
#
# Settings come from the updater's environment (compose.yml fills them from
# .env) and mean what update.conf's fields mean to every other Telium updater:
#
#   TELIUM_UPDATES              automatic | manual
#   TELIUM_PIN                  empty, an image reference, or a sha256: digest
#   TELIUM_PIN_REASON           why; required whenever TELIUM_PIN is set
#   TELIUM_UPDATE_WINDOW        empty, or HH:MM-HH:MM (UTC) for restarts
#   TELIUM_RESTART_NOTICE_SECS  warning given before a restart (default 300)

set -eu

STATE=/state
PIN_OVERRIDE="$STATE/compose.pin.yml"
PROJECT_DIR=/project

TELIUM_UPDATES="${TELIUM_UPDATES:-automatic}"
TELIUM_PIN="${TELIUM_PIN:-}"
TELIUM_PIN_REASON="${TELIUM_PIN_REASON:-}"
TELIUM_UPDATE_WINDOW="${TELIUM_UPDATE_WINDOW:-}"

FORCE_NOW=0
case "${1:-}" in
  --now) FORCE_NOW=1 ;;
  --status)
    echo "mode:    $TELIUM_UPDATES"
    echo "pin:     ${TELIUM_PIN:-<none, following the channel>}"
    echo "reason:  ${TELIUM_PIN_REASON:-<none>}"
    echo "window:  ${TELIUM_UPDATE_WINDOW:-<any time>} (UTC)"
    echo "notice:  ${TELIUM_RESTART_NOTICE_SECS:-300}s"
    if [ -f "$STATE/waiting-breaking" ]; then
      echo "held:    a release marked breaking is pulled and waiting; take it with --now"
    fi
    exit 0
    ;;
  "") ;;
  *) echo "usage: telium-update [--now | --status]" >&2; exit 2 ;;
esac

mkdir -p "$STATE"

announce_once() { # announce_once <marker> <value> <message>
  if [ "$(cat "$STATE/$1" 2>/dev/null || true)" != "$2" ]; then
    printf '%s\n' "$2" > "$STATE/$1"
    echo "$3"
  fi
}

if [ "$TELIUM_UPDATES" = manual ]; then
  announce_once manual manual "TELIUM_UPDATES=manual: checking nothing, changing nothing"
  exit 0
fi
rm -f "$STATE/manual"
if [ "$TELIUM_UPDATES" != automatic ]; then
  echo "WARNING: TELIUM_UPDATES=$TELIUM_UPDATES is neither automatic nor manual; treating it as automatic" >&2
fi

# ------------------------------------------------------- which project, how

self="$(cat /etc/hostname)"
label() { docker inspect --format "{{ index .Config.Labels \"$1\" }}" "$self"; }
project="$(label com.docker.compose.project)"
workdir="$(label com.docker.compose.project.working_dir)"
config_files="$(label com.docker.compose.project.config_files)"
[ -n "$project" ] && [ -n "$workdir" ] || {
  echo "ERROR: this container was not started by docker compose; nothing to update" >&2
  exit 1
}

# The compose files you started the project with, seen through /project.
# Kept as a word list: the paths are /project/<name> and /state/..., and a
# name with a space in it is refused here rather than split later.
files_args=""
old_ifs="$IFS"; IFS=,
for f in $config_files; do
  case "$f" in
    *" "*) IFS="$old_ifs"; echo "ERROR: '$f' has a space in its path; rename it" >&2; exit 1 ;;
    "$workdir"/*) files_args="$files_args -f $PROJECT_DIR${f#"$workdir"}" ;;
    *) IFS="$old_ifs"
       echo "ERROR: $f is outside $workdir, the only directory the updater can see" >&2
       exit 1 ;;
  esac
done
IFS="$old_ifs"

compose() { docker compose -p "$project" --project-directory "$PROJECT_DIR" "$@"; }

# A pin is a compose override on top of your files, so clearing TELIUM_PIN is
# all it takes to follow the channel again.
if [ -n "$TELIUM_PIN" ]; then
  case "$TELIUM_PIN" in
    sha256:*)
      # shellcheck disable=SC2086
      channel="$(compose $files_args config --images server)"
      pinned="${channel%@*}@${TELIUM_PIN}"
      ;;
    *) pinned="$TELIUM_PIN" ;;
  esac
  cat > "$PIN_OVERRIDE" <<EOF
# Written by telium-update from TELIUM_PIN. Change that, not this.
services:
  server:
    image: ${pinned}
EOF
  files_args="$files_args -f $PIN_OVERRIDE"
  if [ -n "$TELIUM_PIN_REASON" ]; then
    announce_once pinned "$TELIUM_PIN" "pinned to ${TELIUM_PIN}. Reason on file: ${TELIUM_PIN_REASON}"
  else
    echo "ERROR: pinned to ${TELIUM_PIN} with no TELIUM_PIN_REASON. The pin is honoured; write down why it is there, or clear it." >&2
  fi
else
  rm -f "$PIN_OVERRIDE" "$STATE/pinned"
fi

container_of() { # container_of <service>
  docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# -------------------------------------------------------- what is running

# Every running service of this project except the updater itself. Read from
# the containers rather than from the profiles in .env, so a profile turned on
# from the command line is still updated.
services="$(docker ps --filter "label=com.docker.compose.project=$project" \
  --format '{{ .Label "com.docker.compose.service" }}' | grep -vx updater | sort -u || true)"
[ -n "$services" ] || exit 0

moved=""
for svc in $services; do
  cid="$(container_of "$svc")"
  [ -n "$cid" ] || continue
  if [ "$svc" = server ]; then
    # Your compose.yml decides the server's image (TELIUM_IMAGE, or a pin).
    # shellcheck disable=SC2086
    ref="$(compose $files_args config --images server)"
  else
    ref="$(docker inspect --format '{{.Config.Image}}' "$cid")"
  fi
  if ! docker pull -q "$ref" >/dev/null; then
    echo "WARNING: could not pull $ref for $svc; trying again next run" >&2
    continue
  fi
  want="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
  have="$(docker inspect --format '{{.Image}}' "$cid")"
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    moved="$moved $svc"
  fi
done

# Silence is the healthy state.
[ -n "$moved" ] || exit 0
moved="${moved# }"

# ---------------------------------------------------------- may it restart

# A server release that marks itself breaking is pulled but waits for a
# person: `docker compose exec updater telium-update --now`.
case " $moved " in
  *" server "*)
    # shellcheck disable=SC2086
    server_ref="$(compose $files_args config --images server)"
    breaking="$(docker image inspect --format '{{ index .Config.Labels "chat.telium.release.breaking" }}' "$server_ref" 2>/dev/null || true)"
    if [ "$breaking" = true ] && [ "$FORCE_NOW" -ne 1 ]; then
      if [ ! -f "$STATE/waiting-breaking" ]; then
        echo held > "$STATE/waiting-breaking"
        echo "this release is marked breaking and is waiting for a person; read its notes, then: docker compose exec updater telium-update --now"
      fi
      exit 0
    fi
    ;;
esac
rm -f "$STATE/waiting-breaking"

# Inside the window, or not at all. An unreadable window is ignored, loudly:
# a typo must not be able to quietly stop security fixes.
in_window() {
  [ -n "$TELIUM_UPDATE_WINDOW" ] || return 0
  case "$TELIUM_UPDATE_WINDOW" in
    [0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]) ;;
    *) echo "WARNING: TELIUM_UPDATE_WINDOW=$TELIUM_UPDATE_WINDOW is not HH:MM-HH:MM; ignoring it" >&2
       return 0 ;;
  esac
  start="$(echo "$TELIUM_UPDATE_WINDOW" | cut -d- -f1 | tr -d :)"
  end="$(echo "$TELIUM_UPDATE_WINDOW" | cut -d- -f2 | tr -d :)"
  now="$(date -u +%H%M)"
  # Strip leading zeros so the shell does not read 0830 as octal.
  start="$(expr "$start" + 0)"; end="$(expr "$end" + 0)"; now="$(expr "$now" + 0)"
  if [ "$start" -le "$end" ]; then
    [ "$now" -ge "$start" ] && [ "$now" -lt "$end" ]
  else
    [ "$now" -ge "$start" ] || [ "$now" -lt "$end" ]
  fi
}
if [ "$FORCE_NOW" -ne 1 ] && ! in_window; then
  announce_once outside-window "$moved" \
    "new images for: $moved -- waiting for TELIUM_UPDATE_WINDOW=$TELIUM_UPDATE_WINDOW (UTC)"
  exit 0
fi
rm -f "$STATE/outside-window"

# ------------------------------------------------------------------ restart

# One warning before anything moves: the server shows connected clients that
# a restart is coming (SIGUSR1), the SFU stops taking new calls and lets
# running ones finish (SIGUSR1). Their own shutdown.notice_secs and
# updates.drain_max_secs cover this script dying mid-wait. --now skips it.
notice="${TELIUM_RESTART_NOTICE_SECS:-300}"
case "$notice" in
  ''|*[!0-9]*)
    echo "WARNING: TELIUM_RESTART_NOTICE_SECS=$notice is not a number; restarting without a notice" >&2
    notice=0 ;;
esac
if [ "$FORCE_NOW" -ne 1 ] && [ "$notice" -gt 0 ]; then
  signalled=0
  for svc in $moved; do
    case "$svc" in
      server|sfu)
        cid="$(container_of "$svc")"
        if [ -n "$cid" ] && docker kill --signal=USR1 "$cid" >/dev/null 2>&1; then signalled=1; fi
        ;;
    esac
  done
  if [ "$signalled" -eq 1 ]; then
    echo "new images for: $moved -- restart notices sent; recreating in ${notice}s"
    sleep "$notice"
  fi
fi

echo "recreating: $moved"
# Only what moved, by name: --no-deps so nothing else is touched, and the
# updater is never on the list, so it never pulls the floor from under itself.
# shellcheck disable=SC2086
compose $files_args up -d --no-deps $moved

# Dangling layers of the images just replaced; nothing tagged is touched.
docker image prune -f >/dev/null 2>&1 || true
