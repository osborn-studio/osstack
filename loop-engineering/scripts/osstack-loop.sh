#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${OSSTACK_REPO:-}"

if [[ -z "$repo" ]]; then
  candidate="$(cd "$script_dir/../.." && pwd)"
  if [[ -f "$candidate/package.json" && -d "$candidate/packages/cli" ]]; then
    repo="$candidate"
  fi
fi

if [[ -n "${OSSTACK_CLI:-}" ]]; then
  read -r -a cli_cmd <<< "$OSSTACK_CLI"
  exec "${cli_cmd[@]}" loop "$@"
fi

if [[ -n "$repo" && -f "$repo/packages/cli/dist/bin.js" ]]; then
  exec node "$repo/packages/cli/dist/bin.js" loop "$@"
fi

if command -v osstack >/dev/null 2>&1; then
  exec osstack loop "$@"
fi

cat >&2 <<'EOF'
osstack loop CLI was not found.

Set OSSTACK_REPO to an osstack checkout and run `pnpm build`, or set
OSSTACK_CLI to an executable command such as `osstack`.
EOF
exit 127
