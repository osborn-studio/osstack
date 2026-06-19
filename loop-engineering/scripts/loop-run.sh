#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="${LOOP_WORKSPACE:-$PWD}"
source_name="${LOOP_SOURCE:-task_queue}"
verify_cmd="${LOOP_VERIFY:-pnpm test}"

args=(run --workspace "$workspace" --source "$source_name" --verify "$verify_cmd")

if [[ -n "${LOOP_EXECUTE:-}" ]]; then
  args+=(--execute "$LOOP_EXECUTE")
fi

if [[ -n "${LOOP_AGENT:-}" ]]; then
  args+=(--agent "$LOOP_AGENT")
fi

if [[ "${LOOP_AUTO_AGENT:-0}" == "1" ]]; then
  args+=(--auto-agent)
fi

if [[ "${LOOP_WORKTREE:-1}" == "1" ]]; then
  args+=(--worktree)
fi

if [[ "${LOOP_ARCHIVE_COMPLETED:-0}" == "1" ]]; then
  args+=(--archive-completed)
fi

exec "$script_dir/osstack-loop.sh" "${args[@]}" "$@"
