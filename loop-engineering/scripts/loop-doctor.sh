#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="${LOOP_WORKSPACE:-$PWD}"

args=(doctor --workspace "$workspace")

if [[ "${LOOP_DAEMON_CHECK:-0}" == "1" ]]; then
  args+=(--daemon)
fi

if [[ "${LOOP_JSON:-0}" == "1" ]]; then
  args+=(--json)
fi

exec "$script_dir/osstack-loop.sh" "${args[@]}" "$@"
