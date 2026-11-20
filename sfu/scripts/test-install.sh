#!/usr/bin/env bash
# Offline checks of the interactive installer's argument handling and plan,
# using --dry-run: nothing is installed, no root needed. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="$here/../install.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$installer" "$@" </dev/null 2>&1; }
expect_ok() { # expect_ok "pattern" args...
  local pattern="$1"; shift
  local out; out="$(run "$@")" || fail "'$*' exited non-zero: $out"
  grep -Fq -- "$pattern" <<<"$out" || fail "'$*' did not print '$pattern': $out"
}
expect_err() { # expect_err "pattern" args...
  local pattern="$1"; shift
  local out; if out="$(run "$@")"; then fail "'$*' should have been refused: $out"; fi
  grep -Fq -- "$pattern" <<<"$out" || fail "'$*' refused for the wrong reason (wanted '$pattern'): $out"
}

expect_ok "install a portable relay" --mode portable --dry-run
expect_ok "install-portable.sh /srv/relay" --mode portable --dir /srv/relay --dry-run
expect_ok "/opt/telium-sfu/bin/telium-sfu --config /opt/telium-sfu/config/sfu.toml configure --private --homeserver chat.example.com" \
  --mode portable --private --homeserver chat.example.com --dry-run
expect_ok "install a full relay" --mode full --proxy caddy-new --dry-run

# Paths the privileged installer must never be pointed at.
for bad in /etc/telium /opt /opt/../etc /opt/./x /opt//x /opt/x/.. relative/path "/opt/x y"; do
  expect_err "--dir must be a dedicated absolute path" --mode portable --dir "$bad" --dry-run
done
expect_err "--dir is for portable mode" --mode full --dir /opt/x --dry-run
expect_err "--proxy is for full mode" --mode portable --proxy caddy-new --dry-run
expect_err "--mode must be full or portable" --mode both --dry-run
expect_err "no terminal to ask on" --dry-run
expect_err "unknown option" --web
expect_err "needs a value" --mode
echo "installer dry-run checks passed"
