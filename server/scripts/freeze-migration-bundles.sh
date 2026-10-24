#!/usr/bin/env bash
# Freezes what this server exports today as a new reference shape for the
# cross-version migration conformance suite (server/tests/conformance.rs;
# docs/migration.md, "Conformance suite").
#
#   server/scripts/freeze-migration-bundles.sh          # the next free name: v2, v2.1, ...
#   server/scripts/freeze-migration-bundles.sh v3       # a name of your choosing
#
# It never overwrites a frozen shape. A shape that has shipped is what some
# server out there still exports, so a new one goes beside the old ones, and
# the suite goes on importing every one of them.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
TELIUM_FREEZE_BUNDLES="${1:-next}" cargo test --manifest-path "$here/Cargo.toml" --test conformance freeze -- --ignored --exact --nocapture
