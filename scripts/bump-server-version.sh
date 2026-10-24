#!/usr/bin/env bash
# Sets the server's version, and prints the command that cuts the release.
#
# WHY A COMMIT AND NOT A TAG FLAG
#
# `telium-server version`, `/_telium/v1/capabilities`, the startup log, every
# backup archive and the `schema_provenance` row all read `CARGO_PKG_VERSION`,
# which is compiled in. A version that existed only in a tag would be a name the
# running binary could not tell you, and "which release is this?" is exactly the
# question an operator asks a server, not a release page.
#
# So the version is a source change: two files, in a commit, before the tag. The
# release workflow refuses a tag whose `server/Cargo.toml` disagrees with it,
# which is what makes forgetting this step a failed release rather than a
# release that reports the previous version forever.
#
# WHY THE SCRIPT AND NOT TWO EDITS
#
# `server/Cargo.lock` records the package version too, and Cargo refuses
# `--locked` when the two disagree. Every build in CI is `--locked`, so a
# Cargo.toml-only bump fails at tag time -- after the tag is pushed, which is the
# expensive moment to find out. This edits both, then asks Cargo itself whether
# the result is consistent.
#
# RELEASE METADATA
#
# The trailers the release workflow reads -- `Security-relevant`,
# `Breaking-change`, `Upgrade-notes` -- are printed on the `git tag -a` command
# rather than committed, because the tag message is what the workflow reads
# first. Putting them on the tag also means they cannot be lost by a squash
# merge, which is what happens to a trailer written in a PR body.
#
# Usage:
#   scripts/bump-server-version.sh 0.2.0
#   scripts/bump-server-version.sh 0.2.1 --security
#   scripts/bump-server-version.sh 0.3.0 --breaking --notes "reindex media on first start"
#   scripts/bump-server-version.sh 0.2.0 --print-only   # no edit, no commit
#
# It edits, commits `Release server <version>`, and prints the tag command. It
# does not tag: pushing a tag starts a release, and that is a decision somebody
# makes deliberately after the bump commit has merged.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: bump-server-version.sh <major.minor.patch> [options]

  --security           the release fixes a vulnerability (trailer: Security-relevant)
  --breaking           an unattended box must wait for a person (trailer: Breaking-change)
  --notes <text>       one line of what that person has to do (trailer: Upgrade-notes)
  --print-only         check the version and print the tag command without editing
  --no-commit          edit the files, leave them staged, do not commit
  -h, --help           this
EOF
  exit 2
}

version=""
security=0
breaking=0
notes=""
print_only=0
commit=1

while [ $# -gt 0 ]; do
  case "$1" in
    --security) security=1; shift ;;
    --breaking) breaking=1; shift ;;
    --notes) notes="${2:-}"; shift 2 ;;
    --print-only) print_only=1; shift ;;
    --no-commit) commit=0; shift ;;
    -h|--help) usage ;;
    -*) echo "bump-server-version: unknown option $1" >&2; usage ;;
    *)
      [ -z "$version" ] || { echo "bump-server-version: version given twice" >&2; usage; }
      version="$1"
      shift
      ;;
  esac
done

[ -n "$version" ] || usage

# The shape the release workflow accepts, checked here so the mismatch is found
# on a laptop rather than at the tag.
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "bump-server-version: '$version' is not major.minor.patch (no leading v, no suffix)" >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$repo/server/Cargo.toml"
lock="$repo/server/Cargo.lock"

[ -f "$manifest" ] || { echo "bump-server-version: $manifest is missing" >&2; exit 1; }
[ -f "$lock" ] || { echo "bump-server-version: $lock is missing" >&2; exit 1; }

current="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$manifest" | head -1)"
if [ -z "$current" ]; then
  echo "bump-server-version: could not read the version from $manifest" >&2
  exit 1
fi

if [ "$current" = "$version" ]; then
  echo "bump-server-version: server/Cargo.toml is already at $version; nothing to change"
elif [ "$print_only" -eq 0 ]; then
  # Both files, in place. `Cargo.lock` is edited by pattern rather than by
  # running `cargo update`, because the latter resolves the whole tree and can
  # move dependencies as a side effect -- a version bump must change one number.
  #
  # The lock stanza is addressed by its package name, not by line number: the
  # `[[package]] name = "telium-server"` block is the only one that carries this
  # version, and `awk` rewrites the first `version =` after that header.
  sed -i "s/^version = \"${current//./\\.}\"$/version = \"$version\"/" "$manifest"
  awk -v want="$version" '
    /^name = "telium-server"$/ { inside = 1; print; next }
    inside && /^version = "/ { sub(/^version = ".*"$/, "version = \"" want "\""); inside = 0; print; next }
    { print }
  ' "$lock" > "$lock.new"
  mv "$lock.new" "$lock"
  echo "bump-server-version: $current -> $version (server/Cargo.toml, server/Cargo.lock)"
else
  echo "bump-server-version: would set $current -> $version (--print-only)"
fi

# Ask Cargo whether the two files agree, rather than trusting the edits. This is
# the same `--locked` check every build runs, so a mismatch fails here instead of
# at the tag.
if [ "$print_only" -eq 0 ]; then
  if ! ( cd "$repo" && cargo metadata --locked --no-deps --format-version 1 --manifest-path server/Cargo.toml >/dev/null 2>&1 ); then
    echo "bump-server-version: cargo metadata --locked rejected the result; server/Cargo.lock and" >&2
    echo "bump-server-version: server/Cargo.toml disagree. Undo the edit and run 'cargo update -p" >&2
    echo "bump-server-version: telium-server --precise $version --manifest-path server/Cargo.toml'." >&2
    exit 1
  fi
fi

tag="server-v$version"

# The trailers go on the tag message. `--security`/`--breaking` are shorthand for
# the two flags the workflow greps for, and `--notes` for the one line it copies
# into the release notes and the manifest.
trailers=""
if [ "$security" -eq 1 ]; then trailers+=$'\nSecurity-relevant: yes'; fi
if [ "$breaking" -eq 1 ]; then trailers+=$'\nBreaking-change: yes'; fi
if [ -n "$notes" ]; then trailers+=$'\nUpgrade-notes: '"$notes"; fi

if [ "$print_only" -eq 0 ] && [ "$commit" -eq 1 ]; then
  ( cd "$repo" && git add server/Cargo.toml server/Cargo.lock )
  if ( cd "$repo" && git diff --cached --quiet ); then
    echo "bump-server-version: nothing staged; the version was already $version"
  else
    ( cd "$repo" && git commit -m "Release server $version" )
    echo "bump-server-version: committed 'Release server $version'"
  fi
fi

cat <<EOF

Next, in this order:

  1. Open a pull request and merge it. The release workflow refuses a tag whose
     commit is not on main.

  2. Wait for the required 'unit-tests' check on that merge commit to pass. The
     release workflow refuses a tag whose commit has no successful run.

  3. Tag the merge commit and push the tag:

       git tag -a $tag -m "Telium Server $version$trailers"
       git push origin $tag

     The tag is annotated on purpose: the workflow reads its message for the
     trailers, and an annotated tag is also what docs/stability.md gate B1 means
     by "a release exists".
EOF
