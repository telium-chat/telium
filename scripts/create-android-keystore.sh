#!/usr/bin/env bash
# Creates the Android release signing key, once, and prints what to store where.
#
# Run this by hand, on a machine you trust, and never in CI. Its output is a
# keystore plus three values that go into the repository's secrets and
# variables. The keystore is the identity of the Android app: every future
# release must be signed with this same key, or Android will refuse to install
# it over the previous version and every user has to uninstall first. There is
# no rotation story that does not cost that, so treat the file like the release
# key it is and keep a copy somewhere that survives a laptop.
#
# Usage:
#   scripts/create-android-keystore.sh [output-directory]
#
# Then, with the `gh` CLI authenticated as an administrator of the repository:
#
#   gh secret set ANDROID_KEYSTORE_BASE64   < android-release.p12.b64
#   gh secret set ANDROID_KEYSTORE_PASSWORD <<< "$KEYSTORE_PASSWORD"
#   gh variable set ANDROID_KEY_ALIAS       --body "$KEY_ALIAS"
#
# All three belong to the `android-release` environment, not the repository, so
# that only a job which declares that environment can read them:
#
#   gh api -X PUT "repos/{owner}/{repo}/environments/android-release"
#   gh secret set ANDROID_KEYSTORE_BASE64 --env android-release < android-release.p12.b64
#   ...and the same --env android-release for the password and the alias
#
# Also set the same three release-manifest values the desktop signing uses, on
# that environment, because the Android update manifest is signed with the same
# key: TELIUM_RELEASE_SIGNING_KEY and TELIUM_RELEASE_KEY_ID as secrets, and
# TELIUM_RELEASE_PUBLIC_KEY as a variable. See docs/updates.md.
#
# Finally, protect the environment in the GitHub UI (Settings → Environments →
# android-release → Required reviewers). Without a reviewer, a protected
# environment still keeps the secrets out of ordinary workflow runs, but it does
# not put a human in front of a release; with one, it does.

set -euo pipefail

OUT_DIR="${1:-$PWD}"

die() {
  echo "create-android-keystore.sh: $*" >&2
  exit 1
}

command -v keytool >/dev/null || die "keytool is required (it ships with any JDK)"
command -v base64 >/dev/null || die "base64 is required"

mkdir -p "$OUT_DIR"
KEYSTORE="$OUT_DIR/android-release.p12"
[[ -e "$KEYSTORE" ]] && die "$KEYSTORE already exists; refusing to overwrite a signing key"

# Generated here rather than asked for. A password somebody types is a password
# somebody reuses, and these are pasted once into a secret store and never
# typed again. Alphanumeric only, because they travel through `keytool`'s
# argument parsing, a base64 blob, and a YAML value, and a shell metacharacter
# that survives all three is a bet with no upside.
#
# Bounded input, then truncation in the shell: piping an unbounded
# `/dev/urandom` into `head -c` leaves the reader to be killed by SIGPIPE, and
# under `set -o pipefail` that turns "generate a password" into "exit 141".
random_secret() {
  local raw
  raw="$(LC_ALL=C head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  printf '%s' "${raw:0:40}"
}

KEYSTORE_PASSWORD="$(random_secret)"
KEY_ALIAS="telium-release"

# PKCS12 rather than JKS: it is the default in every JDK since 9, and apksigner
# reads it without a conversion step. RSA 4096 because the certificate is
# checked by every device that installs the app and the cost is a one-off.
#
# One password, not two. PKCS12 does not support a key password that differs
# from the store password -- `keytool` accepts `-keypass` and then silently
# ignores it, with a warning -- and a script that prints two passwords when
# only one is in effect is a script that produces a keystore nobody can open.
keytool -genkeypair \
  -keystore "$KEYSTORE" \
  -storetype PKCS12 \
  -storepass "$KEYSTORE_PASSWORD" \
  -keypass "$KEYSTORE_PASSWORD" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=Telium, O=Telium, C=US" \
  >/dev/null

# `base64 -w0` is GNU; the BSD base64 on macOS takes no width flag and wraps
# nothing, so the fallback is not a compatibility shim but the same output.
if base64 --help 2>&1 | grep -q -- '--wrap\|-w'; then
  base64 -w0 "$KEYSTORE" > "$KEYSTORE.b64"
else
  base64 < "$KEYSTORE" > "$KEYSTORE.b64"
fi

chmod 600 "$KEYSTORE" "$KEYSTORE.b64"

# The certificate digest, so a later release can be checked against it. This is
# what a user would compare if they were verifying a download by hand.
FINGERPRINT="$(keytool -list -v -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASSWORD" \
  -alias "$KEY_ALIAS" 2>/dev/null \
  | awk -F': ' '/SHA256:/ { print $2; exit }' | tr -d ' ')"

cat <<EOF

Wrote $KEYSTORE and $KEYSTORE.b64

  key alias          $KEY_ALIAS
  keystore password  $KEYSTORE_PASSWORD
  SHA-256            ${FINGERPRINT:-(unavailable; check with keytool -list -v)}

Store both of these before you close this terminal -- they are not written to
any file above. The .b64 file is what goes into the ANDROID_KEYSTORE_BASE64
secret, the password into ANDROID_KEYSTORE_PASSWORD, and the alias into the
ANDROID_KEY_ALIAS variable, all on the android-release environment.

Keep $KEYSTORE offline. Losing it means the next release cannot be installed as
an update by anyone who already has the app; leaking it means somebody else can
publish an update every one of those users will accept.
EOF
