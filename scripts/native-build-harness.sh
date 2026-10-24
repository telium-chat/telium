#!/usr/bin/env bash
# Runs the native-build step's inner script -- the one inside `docker run
# rust:1-slim-bookworm` in release-server.yml -- exactly as extracted from
# the workflow, against stub tools standing in for the container's
# apt/curl/sha256sum/rustup/cargo.
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
# Real tools where the real tool is under test: tar and install run out
# of a bind-mounted /usr, and the stub curl hands them a real tarball in
# the layout the real toolchain archives carry. The pinned sha256 sums
# cannot match stub tarballs (their match against the real ones is proven
# in CI's own log), so that stub checks only which file the check aims
# at. The script's absolute paths (/src checkout, /tmp scratch, /target
# cargo output) are why this runs as mapped root inside a user namespace,
# in a tmpfs rootfs of its own.
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
if ! mknod "$R/dev/null" c 1 3 2>/dev/null; then
  : > "$R/dev/null"
fi
chmod 666 "$R/dev/null"

# -- stubs ----------------------------------------------------------------
S=$R/stubs
printf '#!/bin/sh\nexit 0\n' > "$S/apt-get"

# curl: lands a REAL tarball where -o points, carrying the tree the real
# toolchain tarballs carry. The pack lives under the rootfs's own /tmp,
# which is the /tmp the script's chrooted curl will see.
mkdir -p "$R/tmp/pack/x86_64-linux-musl-cross/bin" "$R/tmp/pack/aarch64-linux-musl-cross/bin"
for arch in x86_64 aarch64; do
  printf '#!/bin/sh\nexit 0\n' > "$R/tmp/pack/${arch}-linux-musl-cross/bin/${arch}-linux-musl-gcc"
  chmod +x "$R/tmp/pack/${arch}-linux-musl-cross/bin/${arch}-linux-musl-gcc"
done
cat > "$S/curl" <<'STUB'
#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || { echo "stub curl: no -o" >&2; exit 2; }
root="$(basename "$out")"
root="${root%.tgz}"
[ -d "/tmp/pack/$root" ] || { echo "stub curl: unexpected download $(basename "$out")" >&2; exit 2; }
exec /usr/bin/tar -czf "$out" -C /tmp/pack "$root"
STUB

cat > "$S/sha256sum" <<'STUB'
#!/bin/sh
[ "${1:-}" = "--check" ] && [ "${2:-}" = "-" ] || { echo "stub sha256sum: unexpected args: $*" >&2; exit 2; }
line="$(cat)"
case "$line" in
  *"  x86_64-linux-musl-cross.tgz"|*"  aarch64-linux-musl-cross.tgz") exit 0 ;;
  *) echo "stub sha256sum: unexpected input: $line" >&2; exit 1 ;;
esac
STUB

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

EXPORTS=()
COMMIT=harness0000000000000000000000000000
COMMIT_TIME=1700000000
BUILD_TIME=1700000000
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

# The checkout the script must not leave.
mkdir -p "$R/src/server"
printf '#[package]\nname = "x"\n' > "$R/src/server/Cargo.toml"
printf 'example = true\n' > "$R/src/server/telium.example.toml"

# -- run ------------------------------------------------------------------
BODY="$(cat "$R/inner.sh")"
chroot "$R" /usr/bin/env -i \
  PATH=/stubs:/usr/bin:/bin \
  HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
  "${EXPORTS[@]}" \
  /usr/bin/bash -euc "cd /src; $BODY"

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
