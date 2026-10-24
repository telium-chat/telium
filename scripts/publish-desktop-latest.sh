#!/usr/bin/env bash
# Mirrors the newest desktop release's download files onto a rolling
# `desktop-latest` release, so the download page and the update manifest have
# one URL that never moves.
#
# WHY A ROLLING RELEASE AT ALL
#
# The website's Windows and Linux buttons need a URL each that survives every
# release without the site being rebuilt. GitHub's `releases/latest` is one
# slot shared by every train in this repository, so it cannot be a per-product
# pointer: a server or Android release taking it would 404 both desktop
# buttons.
#
# So the desktop train gets its own pointer, the way Android has
# `android-latest`. Its tag never moves; each desktop release copies its files
# here with `--clobber`. Every train stays out of the Latest slot explicitly
# (`--latest=false`), so none of them needs a prerelease marker to protect a
# shared pointer.
#
# WHY THE NEWEST TAG WINS
#
# Re-running an old `desktop-v*` tag must not move the pointer backwards. The
# versioned release is still rebuilt and republished -- that is what a re-run
# is for -- but `desktop-latest` only accepts files from the highest tag, so a
# backport or a repair of an older release cannot make the download page serve
# it. The comparison is `sort -V` over the repository's desktop tags, which is
# the same ordering a human reads.
#
# WHAT IS MIRRORED
#
# Only the files the download page and the signed update manifest address, and
# only those present in the directory: the two platform binaries, their
# checksums, the signed manifest, and electron-builder's metadata. Each release
# job has half of them, so both run this and the union converges. The manifest
# is the signed one, and its artifact URLs are tag-scoped, so a client that
# fetches it here still downloads immutable bytes from `desktop-v<version>`.
#
# The convergence is not atomic, and it does not need to be. The two release
# jobs share a concurrency group, so they run one after the other, and between
# them this pointer briefly carries one platform from the new version and the
# other from the previous one. That is the same window the signed manifest has
# always had -- the second signer is what merges the two halves into one entry
# -- so this introduces no new inconsistency, only the same one in one more
# place.
#
# Usage (from a release job, with GH_TOKEN set):
#   scripts/publish-desktop-latest.sh --tag desktop-v0.1.2 --dir ./release \
#     --commit <sha>
#
# `--commit` is used only when the rolling tag does not exist yet, to create
# it at the release's commit. Omit it on a backfill if the tag is already
# there.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: publish-desktop-latest.sh --tag desktop-v<version> --dir <directory> [--commit <sha>]
EOF
  exit 2
}

tag=""
dir=""
commit=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:-}"; shift 2 ;;
    --dir) dir="${2:-}"; shift 2 ;;
    --commit) commit="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "publish-desktop-latest: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$tag" ] || usage
[ -n "$dir" ] || usage
[ -d "$dir" ] || { echo "publish-desktop-latest: $dir is not a directory" >&2; exit 1; }

repo="${GITHUB_REPOSITORY:-telium-chat/telium}"
# `gh` reads GH_TOKEN; the workflows set it on the step. GITHUB_TOKEN is the
# name the rest of this repository's scripts use for the same credential.
: "${GH_TOKEN:=${GITHUB_TOKEN:-}}"
export GH_TOKEN
[ -n "$GH_TOKEN" ] || { echo "publish-desktop-latest: GH_TOKEN or GITHUB_TOKEN must be set" >&2; exit 1; }

# Which release may move the pointer. Read through the API rather than
# `gh release list`, because the API says whether a release is a draft and a
# draft is not published: a tag that only exists as an unpublished draft must
# not decide what the download page serves.
releases="$(gh api --paginate "repos/$repo/releases?per_page=100" \
  --jq '.[] | select(.draft == false) | .tag_name')"
newest="$(printf '%s\n' "$releases" \
  | grep -E '^desktop-v[0-9]' \
  | sort -V \
  | tail -n 1 || true)"

if [ -z "$newest" ]; then
  echo "publish-desktop-latest: no desktop-v* release found; refusing to create the pointer" >&2
  exit 1
fi

if [ "$newest" != "$tag" ]; then
  echo "publish-desktop-latest: $tag is not the newest desktop release ($newest); leaving desktop-latest alone"
  exit 0
fi

# An allowlist, not `release/*`: the directory also carries files this pointer
# has no use for, and a future artifact should be added here deliberately
# rather than mirrored by accident.
assets=()
for name in \
  Telium_x86_64.AppImage \
  Telium_Setup_x64.exe \
  SHA256SUMS-linux-x86_64 \
  SHA256SUMS-windows-x86_64 \
  client-releases.json \
  client-releases.json.sig \
  latest-linux.yml \
  latest.yml
do
  if [ -s "$dir/$name" ]; then
    assets+=("$dir/$name")
  fi
done

if [ ${#assets[@]} -eq 0 ]; then
  echo "publish-desktop-latest: nothing to mirror in $dir" >&2
  exit 1
fi

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT

cat > "$notes" <<'EOF'
This release is a stable download address, not a version.

It carries the newest desktop build — the Linux AppImage and the Windows
installer — and the signed update manifest (`client-releases.json`) that
installed desktop clients fetch. The tag never moves; each `desktop-v*` release
copies its files here.

**It is not where you choose a version from.** Release notes and older versions
live on the versioned `desktop-v*` releases, and the signed manifest names those
tag-scoped URLs, so an update installed from here still comes from an immutable
release. See the [release list](https://github.com/telium-chat/telium/releases).
EOF

title="Telium Desktop — latest"

if gh release view desktop-latest --repo "$repo" >/dev/null 2>&1; then
  gh release upload desktop-latest "${assets[@]}" --clobber --repo "$repo"
  gh release edit desktop-latest --repo "$repo" \
    --title "$title" --notes-file "$notes" --latest=false
  echo "publish-desktop-latest: refreshed desktop-latest from $tag"
  exit 0
fi

# No release yet. The tag may still exist -- an earlier run can have created it
# and then failed before the release landed -- so create it only when genuinely
# absent, and the release then attaches to it.
#
# The tag is made through the refs API rather than the release's `--target`,
# because with a target the release API resolves every commit between the
# target and the default branch's head and demands `workflows: write` -- a
# scope GITHUB_TOKEN can never hold -- whenever one of those commits touched a
# workflow file. The failure surfaces as a bare 403 that names no missing
# permission (cli/cli#9514).
if ! gh api "repos/$repo/git/ref/tags/desktop-latest" >/dev/null 2>&1; then
  sha="${commit:-$(gh api "repos/$repo/commits/$tag" --jq .sha)}"
  gh api -X POST "repos/$repo/git/refs" -f ref=refs/tags/desktop-latest -f sha="$sha" >/dev/null
fi

# A normal release, and explicitly not the "Latest" one. The Latest slot is
# owned by `desktop-v*` (`--latest` in both desktop workflows), because clients
# built before this pointer existed read `releases/latest` and cannot be
# changed. This release is a download address, so `--latest=false` says that
# without needing a prerelease marker.
gh release create desktop-latest "${assets[@]}" \
  --repo "$repo" \
  --title "$title" \
  --notes-file "$notes" \
  --latest=false

echo "publish-desktop-latest: created desktop-latest from $tag"
