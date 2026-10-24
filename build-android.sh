#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT_DIR/web"
ANDROID_DIR="$WEB_DIR/src-tauri/gen/android"
NDK_VERSION="${NDK_VERSION:-27.0.12077973}"

# Which variant to build.
#
# `debug` is what a developer wants: installable without a signing key, and
# allowed to talk cleartext to a local homeserver. `release` is what gets
# published, and it is a different build, not a flag on the same one: the
# release variant is not debuggable, forbids cleartext, and is left *unsigned*
# here on purpose. Signing happens in CI with a key this script never sees, so
# a release build on a workstation cannot accidentally be signed with whatever
# happens to be lying around.
BUILD_TYPE="${TELIUM_ANDROID_BUILD_TYPE:-debug}"
case "$BUILD_TYPE" in
  debug|release) ;;
  *)
    echo "build-android.sh: TELIUM_ANDROID_BUILD_TYPE must be debug or release, got '$BUILD_TYPE'" >&2
    exit 1
    ;;
esac
# Found rather than named, because the file is `app-arm64-<type>.apk` for a
# debug build and `app-arm64-release-unsigned.apk` for a release one -- the
# `-unsigned` suffix is Gradle's, added exactly when there is no signing config,
# which is the arrangement this script depends on.
APK_DIR="$ANDROID_DIR/app/build/outputs/apk/arm64/$BUILD_TYPE"

die() {
  echo "build-android.sh: $*" >&2
  exit 1
}

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$ANDROID_HOME" && -d "${HOME:-}/Android/Sdk" ]]; then
  ANDROID_HOME="${HOME}/Android/Sdk"
fi
[[ -n "$ANDROID_HOME" ]] || die "set ANDROID_HOME or ANDROID_SDK_ROOT"
[[ -d "$ANDROID_HOME/platforms/android-36" ]] || die "Android API 36 is not installed under $ANDROID_HOME"
[[ -d "$ANDROID_HOME/ndk/$NDK_VERSION" ]] || die "Android NDK $NDK_VERSION is not installed under $ANDROID_HOME"

export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
export ANDROID_NDK_HOME="$NDK_HOME"

command -v java >/dev/null || die "Java 17 is required"
command -v bun >/dev/null || die "Bun is required"
command -v python3 >/dev/null || die "Python 3 is required"
command -v rustup >/dev/null || die "rustup is required"

JAVA_MAJOR="$(java -version 2>&1 | awk -F '"' '/version/ { split($2, parts, "."); print parts[1]; exit }')"
[[ "$JAVA_MAJOR" == "17" ]] || die "Java 17 is required; found Java $JAVA_MAJOR"

RUST_TARGET="aarch64-linux-android"
if ! rustup target list --installed | grep -qx "$RUST_TARGET"; then
  rustup target add "$RUST_TARGET"
fi

# `rustup` being installed is not the same as the `cargo` on PATH being the
# rustup one. A distro-packaged cargo (Arch, and several others) shadows the
# shim in `~/.cargo/bin`, installs its own toolchain, and has no Android
# std -- the build then fails deep inside a dependency with "can't find crate
# for `std`", which reads like a broken target rather than a wrong compiler.
# Asking rustc for the target's library directory answers the actual question.
RUST_TARGET_LIBDIR="$(rustc --print target-libdir --target "$RUST_TARGET" 2>/dev/null || true)"
if [[ -z "$RUST_TARGET_LIBDIR" || ! -d "$RUST_TARGET_LIBDIR" ]]; then
  die "the rustc on PATH ($(command -v rustc)) has no std for $RUST_TARGET.
  It is probably a distro package rather than the rustup toolchain. Put
  \$HOME/.cargo/bin first on PATH, or run 'rustup target add $RUST_TARGET' with
  the toolchain you intend to build with."
fi

# Kotlin 2.3 rejects the legacy syntax still shipped by Tauri 2.11.5. Patch
# the checked-in generated app file and any matching cached Tauri Android
# modules before Gradle parses them. The changes are deterministic and local
# to the build machine; the app file remains fixed in the repository as well.
FIXER="$ROOT_DIR/scripts/ensure_android_gradle.py"
python3 "$FIXER" "$ANDROID_DIR/app/build.gradle.kts"

# The Tauri Android Gradle module lives in Cargo's registry, not this repo.
# On a cold runner it does not exist until Cargo resolves/fetches dependencies,
# so fetch first and then apply the same deterministic Kotlin-DSL compatibility
# patch before Gradle ever parses that module.
cargo fetch --manifest-path "$WEB_DIR/src-tauri/Cargo.toml"

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
if [[ -d "$CARGO_HOME_DIR/registry/src" ]]; then
  while IFS= read -r -d '' gradle_file; do
    python3 "$FIXER" "$gradle_file"
  done < <(
    find "$CARGO_HOME_DIR/registry/src" \
      -type f -name 'build.gradle.kts' -path '*/android/*' -print0
  )
fi

grep -q 'jvmTarget.set(JvmTarget.JVM_1_8)' "$ANDROID_DIR/app/build.gradle.kts" \
  || die "the generated Android app Gradle file was not migrated to compilerOptions"

# Do not enter the expensive Rust/Gradle build if a fetched Tauri/plugin module
# still contains Kotlin's now-rejected String jvmTarget assignment.
if grep -R -n -E 'jvmTarget[[:space:]]*=[[:space:]]*["'\''"]1\.8["'\''"]' \
    "$ANDROID_DIR" "$CARGO_HOME_DIR/registry/src" 2>/dev/null; then
  die "legacy Kotlin jvmTarget syntax remains after Android Gradle patching"
fi

# The APK's identity.
#
# `tauri android build` regenerates `app/tauri.properties` from
# `tauri.conf.json` on every run, so writing that file here does nothing --
# which is what an earlier version of this script did, and why every APK it
# produced claimed the config's version regardless. The supported way to set
# both `versionName` and the derived `versionCode` is to override the config
# for this one invocation.
#
# Tauri derives versionCode from the version as major*1e6 + minor*1e3 + patch,
# so 0.1.3 becomes 1003 and 0.2.0 becomes 2000. That is monotonic for any
# sequence of increasing versions, which is the contract a release tag carries;
# Android refuses to install a package whose versionCode is not greater than
# the one already on the device.
#
# The formula ignores any prerelease suffix, so `0.1.3-beta.1` and `0.1.3` both
# yield 1003. Published builds therefore require a plain `X.Y.Z` tag -- see the
# tag check in `build-android-arm64.yml` -- because a beta and the release it
# leads to must not share a versionCode.
#
# A release tag names the version when there is one: `android-v0.1.3` builds an
# APK that reports 0.1.3, so the build on a phone can be matched to the release
# it came from. A build without a tag falls back to the package version.
if [[ -n "${TELIUM_APP_VERSION:-}" ]]; then
  APP_VERSION="$TELIUM_APP_VERSION"
else
  APP_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WEB_DIR/package.json")"
fi
[[ "$APP_VERSION" =~ ^[0-9]+(\.[0-9]+)+([-+][0-9A-Za-z.-]+)?$ ]] \
  || die "APP_VERSION '$APP_VERSION' is not a version number"

if [[ "$BUILD_TYPE" == "release" && "$APP_VERSION" == *-* ]]; then
  echo "build-android.sh: warning: '$APP_VERSION' has a prerelease suffix, which" >&2
  echo "  Tauri drops when computing versionCode. A later '$APP_VERSION' without" >&2
  echo "  the suffix would get the same versionCode and could not be installed" >&2
  echo "  over this build. Published releases use plain X.Y.Z tags." >&2
fi

SHORT_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"
COMMIT_TIME="$(git -C "$ROOT_DIR" log -1 --format=%ct 2>/dev/null || true)"
[[ -n "$COMMIT_TIME" ]] || COMMIT_TIME="$(date -u +%s)"

echo "build-android.sh: version $APP_VERSION ($BUILD_TYPE), commit $SHORT_COMMIT"

cd "$WEB_DIR"
bun install --frozen-lockfile
# The same build identity the container image and the desktop app use, so an
# Android bug report names a commit rather than saying `dev`. The version is
# exported too: `vite.config.js` reads `TELIUM_APP_VERSION`, and this is what
# keeps the number in the APK's manifest and the number in the settings footer
# the same one rather than two that agree by coincidence.
export TELIUM_APP_VERSION="$APP_VERSION"
export TELIUM_BUILD_ID="$SHORT_COMMIT"
export TELIUM_BUILD_TIME="$COMMIT_TIME"
TAURI_ARGS=(--apk --target aarch64 --split-per-abi)
if [[ "$BUILD_TYPE" == "debug" ]]; then
  TAURI_ARGS=(--debug "${TAURI_ARGS[@]}")
fi
# `--config` is how the version reaches Gradle. Passed as JSON on the command
# line rather than through a generated file, because the CLI regenerates the
# file this used to write.
bun run tauri -- android build "${TAURI_ARGS[@]}" --config "{\"version\":\"$APP_VERSION\"}"

# Exactly one APK, found rather than named. Gradle decides the filename, and it
# appends `-unsigned` to a release build only when there is no signing config --
# which is the arrangement this script relies on, so the suffix is a fact to
# discover rather than to assume.
shopt -s nullglob
APKS=("$APK_DIR"/*.apk)
shopt -u nullglob
if [[ "${#APKS[@]}" -ne 1 ]]; then
  die "expected exactly one $BUILD_TYPE APK in $APK_DIR, found ${#APKS[@]}"
fi
APK="${APKS[0]}"

# A stable name for the file somebody downloads, and the name the website asks
# for. Set by CI; absent for a local build, which keeps the Gradle path.
if [[ -n "${TELIUM_APK_OUT:-}" ]]; then
  mkdir -p "$(dirname -- "$TELIUM_APK_OUT")"
  cp -- "$APK" "$TELIUM_APK_OUT"
  echo "Copied to $TELIUM_APK_OUT"
fi

echo
echo "APK: $APK"
if command -v sha256sum >/dev/null; then
  echo "SHA-256: $(sha256sum "$APK" | awk '{print $1}')"
fi
