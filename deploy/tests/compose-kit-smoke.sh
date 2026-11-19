#!/usr/bin/env bash
#
# End-to-end check of deploy/compose/: boot the kit from nothing but
# compose.yml and a two-line .env, then publish a new server image and watch
# the updater container replace the running server by itself.
#
# Needs a Docker host (CI's runner). Uses a throwaway local registry so that
# "a release came out" can be staged without touching ghcr.io:
#
#   BASE_IMAGE   the server image to build the test images from
#                (default ghcr.io/telium-chat/telium:server-latest)
#
# The test images are BASE_IMAGE with this checkout's deploy/compose/update.sh
# laid over it, so the updater logic under test is the one in this tree.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/telium-chat/telium:server-latest}"
REG=127.0.0.1:5055
IMG="$REG/telium-smoke:server-latest"
work="$(mktemp -d)"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- compose ps"; (cd "$work/kit" && docker compose ps -a) || true
    echo "---- logs"; (cd "$work/kit" && docker compose logs --no-color --tail=80) || true
  fi
  (cd "$work/kit" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  docker rm -f telium-smoke-registry >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
wait_for() { # wait_for <seconds> <description> <command...>
  local secs="$1" what="$2"; shift 2
  for _ in $(seq "$secs"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out after ${secs}s waiting for: $what" >&2
  return 1
}

step "registry and release A"
docker run -d --name telium-smoke-registry -p "$REG:5000" registry:2 >/dev/null
docker pull -q "$BASE_IMAGE" >/dev/null
mkdir -p "$work/img" "$work/kit"
cp "$repo/deploy/compose/update.sh" "$work/img/update.sh"
build() { # build <release-label>
  cat > "$work/img/Dockerfile" <<EOF
FROM $BASE_IMAGE
COPY update.sh /usr/share/telium/deploy/compose/update.sh
LABEL chat.telium.smoke.release=$1
EOF
  docker build -q -t "$IMG" "$work/img" >/dev/null
  docker push -q "$IMG" >/dev/null
  docker image inspect --format '{{.Id}}' "$IMG"
}
release_a="$(build a)"

step "install: compose.yml + .env, nothing else"
cp "$repo/deploy/compose/compose.yml" "$work/kit/compose.yml"
cat > "$work/kit/.env" <<EOF
TELIUM_DOMAIN=chat.example.org
TELIUM_REGISTRATION=closed
TELIUM_IMAGE=$IMG
TELIUM_RESTART_NOTICE_SECS=0
TELIUM_UPDATE_INTERVAL_SECS=5
EOF
cd "$work/kit"
docker compose config -q
docker compose up -d
wait_for 90 "server health on 127.0.0.1:8448" curl -fsS http://127.0.0.1:8448/_telium/v1/health
curl -fsS http://127.0.0.1:8448/.well-known/telium/server | tee /dev/stderr | grep chat.example.org >/dev/null

step "generated config and the operator commands the docs give"
docker compose exec -T server grep -qx 'open = false' /var/lib/telium/telium.toml
docker compose exec -T server grep -qx 'first_account_is_admin = false' /var/lib/telium/telium.toml
if docker compose exec -T server grep -q '@[A-Z_]*@' /var/lib/telium/telium.toml; then
  echo "an @PLACEHOLDER@ was left unfilled" >&2; exit 1
fi
docker compose exec -T server telium-server check
docker compose exec -T server telium-server registration-code bootstrap | grep -qi "registration code"
docker compose exec -T server telium-server backup list >/dev/null

step "the updater loads its logic from the server image"
wait_for 60 "telium-update inside the updater" docker compose exec -T updater test -x /usr/local/bin/telium-update
docker compose exec -T updater telium-update --status | tee /dev/stderr | grep "mode:    automatic" >/dev/null

step "release B: the updater should move the server on its own"
release_b="$(build b)"
[ "$release_a" != "$release_b" ]
server_image() { docker inspect --format '{{.Image}}' "$(docker compose ps -q server)"; }
wait_for 120 "the server running release B" sh -c "[ \"\$(docker inspect --format '{{.Image}}' \$(docker compose ps -q server))\" = '$release_b' ]"
wait_for 90 "server health after the update" curl -fsS http://127.0.0.1:8448/_telium/v1/health
[ "$(server_image)" = "$release_b" ]
# The updater never recreates itself.
[ "$(docker compose ps -q updater | wc -l)" -eq 1 ]

step "manual mode changes nothing"
echo "TELIUM_UPDATES=manual" >> .env
docker compose up -d updater
build c >/dev/null
sleep 20
[ "$(server_image)" = "$release_b" ]

echo
echo "compose kit smoke: OK"
