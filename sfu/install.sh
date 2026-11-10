#!/usr/bin/env bash
# Bootstrap only. Choose full vs portable *in the browser*, before any
# apt/nginx/firewall/service changes. A minimal Python 3 install is required.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo/root: sudo bash sfu/install.sh" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed for the local web installer. Install python3 and rerun." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/Cargo.toml" && -f "$SCRIPT_DIR/../telium-protocol/Cargo.toml" ]]; then
  SRC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  for command_name in curl tar; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "Missing $command_name; install it before running the web installer." >&2; exit 1;
    }
  done
  TMP_SRC="$(mktemp -d)"
  trap 'rm -rf "$TMP_SRC"' EXIT
  curl -fsSL https://github.com/telium-chat/telium/archive/refs/heads/main.tar.gz -o "$TMP_SRC/telium.tar.gz"
  tar xzf "$TMP_SRC/telium.tar.gz" -C "$TMP_SRC"
  SRC_ROOT="$TMP_SRC/telium-main"
fi

python3 "$SRC_ROOT/sfu/scripts/install-wizard.py" --source-root "$SRC_ROOT"
