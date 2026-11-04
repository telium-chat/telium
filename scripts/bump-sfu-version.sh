#!/usr/bin/env bash
# Sets the SFU's version, and prints the command that cuts the release.
#
# The same shape as bump-server-version.sh, on the SFU's own release train: the
# version lives in `sfu/Cargo.toml` (compiled in as CARGO_PKG_VERSION and printed
# by `telium-sfu version`), and `sfu/Cargo.lock` records it too, so a
# Cargo.toml-only bump fails every `--locked` build in CI -- after the tag is
# pushed, which is the expensive moment to find out. This edits both, then asks
# Cargo itself whether the result is consistent.
#
# The trailers the release workflow reads -- `Security-relevant`,
# `Breaking-change`, `Upgrade-notes` -- are printed on the `git tag -a` command
# rather than committed, because the tag message is what the workflow reads
# first. Putting them on the tag also means they cannot be lost by a squash
# merge, which is what happens to a trailer written in a PR body.
#
# Usage:
#   scripts/bump-sfu-version.sh 0.2.0
#   scripts/bump-sfu-version.sh 0.2.1 --security
#   scripts/bump-sfu-version.sh 0.3.0 --breaking --notes "mint keys with the new envelope"
#   scripts/bump-sfu-version.sh 0.2.0 --print-only   # no edit, no commit
#
# It edits, commits `Release sfu <version>`, and prints the tag command. It
# does not tag: pushing a tag starts a release, and that is a decision somebody
# makes deliberately after the bump commit has merged.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: bump-sfu-version.sh <major.minor.patch> [options]

  --security           the release fixes a vulnerability (trailer: Security-relevant)
  --breaking           an unattended relay must wait for a person (trailer: Breaking-change)
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
    -*) echo "bump-sfu-version: unknown option $1" >&2; usage ;;
    *)
      [ -z "$version" ] || { echo "bump-sfu-version: version given twice" >&2; usage; }
      version="$1"
      shift
      ;;
  esac
done

[ -n "$version" ] || usage

# The shape the release workflow accepts, checked here so the mismatch is found
# on a laptop rather than at the tag.
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "bump-sfu-version: '$version' is not major.minor.patch (no leading v, no suffix)" >&2
  exit 1
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$repo/sfu/Cargo.toml"
lock="$repo/sfu/Cargo.lock"

[ -f "$manifest" ] || { echo "bump-sfu-version: $manifest is missing" >&2; exit 1; }
[ -f "$lock" ] || { echo "bump-sfu-version: $lock is missing" >&2; exit 1; }

current="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$manifest" | head -1)"
if [ -z "$current" ]; then
  echo "bump-sfu-version: could not read the version from $manifest" >&2
  exit 1
fi

if [ "$current" = "$version" ]; then
  echo "bump-sfu-version: sfu/Cargo.toml is already at $version; nothing to change"
elif [ "$print_only" -eq 0 ]; then
  # Both files, in place. `Cargo.lock` is edited by pattern rather than by
  # running `cargo update`, because the latter resolves the whole tree and can
  # move dependencies as a side effect -- a version bump must change one number.
  sed -i "s/^version = \"${current//./\\.}\"$/version = \"$version\"/" "$manifest"
  awk -v want="$version" '
    /^name = "telium-sfu"$/ { inside = 1; print; next }
    inside && /^version = "/ { sub(/^version = ".*"$/, "version = \"" want "\""); inside = 0; print; next }
    { print }
  ' "$lock" > "$lock.new"
  mv "$lock.new" "$lock"
  echo "bump-sfu-version: $current -> $version (sfu/Cargo.toml, sfu/Cargo.lock)"
else
  echo "bump-sfu-version: would set $current -> $version (--print-only)"
fi

# Ask Cargo whether the two files agree, rather than trusting the edits. This is
# the same `--locked` check every build runs, so a mismatch fails here instead of
# at the tag.
if [ "$print_only" -eq 0 ]; then
  if ! ( cd "$repo" && cargo metadata --locked --no-deps --format-version 1 --manifest-path sfu/Cargo.toml >/dev/null 2>&1 ); then
    echo "bump-sfu-version: cargo metadata --locked rejected the result; sfu/Cargo.lock and" >&2
    echo "bump-sfu-version: sfu/Cargo.toml disagree. Undo the edit and run 'cargo update -p" >&2
    echo "bump-sfu-version: telium-sfu --precise $version --manifest-path sfu/Cargo.toml'." >&2
    exit 1
  fi
fi

tag="sfu-v$version"

# The trailers go on the tag message. `--security`/`--breaking` are shorthand for
# the two flags the workflow greps for, and `--notes` for the one line it copies
# into the release notes and the manifest.
trailers=""
if [ "$security" -eq 1 ]; then trailers+=$'\nSecurity-relevant: yes'; fi
if [ "$breaking" -eq 1 ]; then trailers+=$'\nBreaking-change: yes'; fi
if [ -n "$notes" ]; then trailers+=$'\nUpgrade-notes: '"$notes"; fi

if [ "$print_only" -eq 0 ] && [ "$commit" -eq 1 ]; then
  ( cd "$repo" && git add sfu/Cargo.toml sfu/Cargo.lock )
  if ( cd "$repo" && git diff --cached --quiet ); then
    echo "bump-sfu-version: nothing staged; the version was already $version"
  else
    ( cd "$repo" && git commit -m "Release sfu $version" )
    echo "bump-sfu-version: committed 'Release sfu $version'"
  fi
fi

cat <<EOF

Next, in this order:

  1. Open a pull request and merge it. The release workflow refuses a tag whose
     commit is not on main.

  2. Wait for the required 'unit-tests' check on that merge commit to pass. The
     release workflow refuses a tag whose commit has no successful run.

  3. Tag the merge commit and push the tag:

       git tag -a $tag -m "Telium SFU $version$trailers"
       git push origin $tag

     The tag is annotated on purpose: the workflow reads its message for the
     trailers, and the SFU release train is independent of the server's --
     a relay updates only when the relay changed.
EOF
