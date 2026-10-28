#!/usr/bin/env bash
# Runs the native-build step's inner script -- the one inside `docker run
# rust:1-slim-bookworm` in release-server.yml -- exactly as extracted from
# the workflow, against stub tools standing in for the container's
# apt/rustup/cargo, once per matrix architecture.
#
# Why this exists: that script's control flow cannot be executed anywhere
# cheaper than the real CI run, and each of the three times it went wrong
# -- no curl in the slim image, `install` without `-D`, a toolchain `cd`
# leaking into the build -- it cost a full pipeline round trip to find
# out. This harness executes the whole flow on a laptop in seconds: the
# script is lifted verbatim from the workflow file, the failure modes
# already hit are the ones the stubs fail loudly on, and the assertion
# that matters most -- cargo standing in the checkout where the manifest
# is -- is checked on every run.
#
# The script is now parameterized by NATIVE_ARCH (the workflow's matrix
# hands each runner its own architecture; the harness runs both values,
# because a variable that only ever took one value in rehearsal is a
# variable that breaks on the second runner). The toolchain downloads the
# old harness stubbed -- musl.cc tarballs and their sha256 pins, now the
# Wayback fallback -- are gone from the workflow entirely, so their stubs
# are gone from here; what remains to rehearse is the parameterization,
# the CARGO_TARGET_DIR contract, and the staging layout the packaging
# loop consumes.
#
# Real tools where the real tool is under test: install and chown run out
# of a bind-mounted /usr. The script's absolute paths (/src checkout,
# /target cargo output) are why this runs as mapped root inside a user
# namespace, in a tmpfs rootfs of its own.
#
# Usage: scripts/native-build-harness.sh   # no arguments; exits non-zero
#                                          # with a FAIL: line on breakage
set -euo pipefail

if [ "${NATIVE_HARNESS_INNER:-}" != "1" ]; then
  exec unshare --user --map-root-user --mount env NATIVE_HARNESS_INNER=1 bash "$0"
fi

# ---- inside the namespace. The rootfs is a tmpfs, so the absolute paths
# ---- exist here without touching the host.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
R=/tmp/nsroot
mkdir -p "$R"
mount -t tmpfs none "$R"

# The shape bash and its tools need: a bind of the real /usr (unified
# layout), the loader directories where the linker looks for them, and a
# writable /dev/null -- mknod is not available in the namespace, and a
# plain file is enough for the two lines of output the script discards.
mkdir -p "$R/usr" "$R/src" "$R/tmp" "$R/target" "$R/stubs" "$R/dev"
mount --bind /usr "$R/usr"
ln -s usr/bin "$R/bin"
ln -s usr/lib64 "$R/lib64"
ln -s usr/lib "$R/lib"
# The inner script chowns the container's cargo registry back to the host
# user, and the rehearsal must be able to run that same line: shadow
# usr/local with a tmpfs -- writing through the /usr bind would touch the
# real /usr -- then give it the path the rust image has.
[ -d "$R/usr/local" ] || { echo "harness: /usr/local missing from the /usr bind" >&2; exit 2; }
mount -t tmpfs none "$R/usr/local"
mkdir -p "$R/usr/local/cargo/registry"
if ! mknod "$R/dev/null" c 1 3 2>/dev/null; then
  : > "$R/dev/null"
fi
chmod 666 "$R/dev/null"

# -- stubs ----------------------------------------------------------------
S=$R/stubs
printf '#!/bin/sh\nexit 0\n' > "$S/apt-get"

cat > "$S/rustup" <<'STUB'
#!/bin/sh
[ "$1 $2" = "target add" ] || { echo "stub rustup: unexpected args: $*" >&2; exit 2; }
exit 0
STUB

cat > "$S/cargo" <<'STUB'
#!/bin/sh
[ -f "server/Cargo.toml" ] || {
  echo "FAIL: cargo invoked in $(pwd) where server/Cargo.toml does not exist" >&2
  exit 101
}
for want in --release --locked; do
  case " $* " in *" $want "*) ;; *) echo "FAIL: cargo args missing $want" >&2; exit 2 ;; esac
done
# One --target per invocation, resolving from the same relative manifest.
triple="$(expr " $* " : ".* --target \([a-z0-9_-]*\) .*$")"
case "$triple" in
  x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;;
  *) echo "FAIL: cargo target not a musl triple: '$triple'" >&2; exit 2 ;;
esac
# Output goes where cargo really puts it: CARGO_TARGET_DIR when set, the
# manifest directory's target/ when not -- which is exactly the assumption
# about the default that one CI run died on. The post-run assertion below
# (no server/target in the checkout) is what turns this model into a
# check that the workflow's CARGO_TARGET_DIR is still being passed.
dir="${CARGO_TARGET_DIR:-server/target}"
mkdir -p "$dir/$triple/release"
printf '#!/bin/sh\nexit 0\n' > "$dir/$triple/release/telium-server"
chmod +x "$dir/$triple/release/telium-server"
echo "cargo ok in $(pwd) for $triple -> $dir"
STUB
chmod +x "$S"/*

# -- the script, verbatim from the workflow -------------------------------
awk "/rust:1-slim-bookworm bash -euc '/{flag=1; next} /^            '/{flag=0} flag" \
  "$REPO/.github/workflows/release-server.yml" > "$R/inner.sh"
[ -s "$R/inner.sh" ] || { echo "harness: extracted nothing -- did the docker run line move?" >&2; exit 2; }

# The container environment, parsed from the same workflow block rather
# than second-guessed: every `-e KEY=VALUE` on the docker run becomes part
# of the chroot's environment, with the commit identity set to dummies --
# the script only ever writes these back into its output. If a `-e` line
# is ever dropped from the workflow -- as CARGO_TARGET_DIR once was, with
# a silent default waiting underneath -- the script here runs without it
# exactly as the container would.
ENVLINES="$(awk '/docker run --rm/{f=1} f && /(^ *)-e /{sub(/^ *-e /,""); sub(/ \\$/,""); print} /rust:1-slim-bookworm bash/{exit}' \
  "$REPO/.github/workflows/release-server.yml")"
[ -n "$ENVLINES" ] || { echo "harness: found no -e flags -- did the docker run shape change?" >&2; exit 2; }

COMMIT=harness0000000000000000000000000000
COMMIT_TIME=1700000000
BUILD_TIME=1700000000

# The checkout the script must not leave.
mkdir -p "$R/src/server"
printf '#[package]\nname = "x"\n' > "$R/src/server/Cargo.toml"
printf 'example = true\n' > "$R/src/server/telium.example.toml"

# One rehearsal per matrix leg: the same script, the same environment
# shape, a different NATIVE_ARCH -- which is the whole cross-cutting
# surface the workflow hands each runner.
for ARCH in x86_64 aarch64; do
  EXPORTS=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key="${line%%=*}"
    case "$key" in
      # The harness is the container's root, so it supplies these itself.
      HOST_UID|HOST_GID) continue ;;
    esac
    eval "value=${line#*=}"
    EXPORTS+=("$key=$value")
  done <<< "$ENVLINES"

  BODY="$(cat "$R/inner.sh")"
  chroot "$R" /usr/bin/env -i \
    PATH=/stubs:/usr/bin:/bin \
    HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
    "${EXPORTS[@]}" \
    /usr/bin/bash -euc "cd /src; $BODY"
done

# What the script owes the host-side packaging loop that follows it.
test -x "$R/src/.native/stage/x86_64/telium-server" || { echo "FAIL: x86_64 binary not staged" >&2; exit 1; }
test -x "$R/src/.native/stage/aarch64/telium-server" || { echo "FAIL: aarch64 binary not staged" >&2; exit 1; }
# And the checkout must be clean of build output: cargo's default target
# directory is next to the manifest, and if build output ever lands there
# again it means CARGO_TARGET_DIR stopped reaching the container -- the
# checkout would be collecting root-written files the runner user cannot
# remove, exactly as one CI run left behind.
test ! -e "$R/src/server/target" || { echo "FAIL: build output landed in the checkout instead of the volume" >&2; exit 1; }
echo "harness: control flow verified"
