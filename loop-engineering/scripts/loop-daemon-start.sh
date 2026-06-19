#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="${LOOP_WORKSPACE:-$PWD}"
source_name="${LOOP_SOURCE:-task_queue}"
interval_ms="${LOOP_INTERVAL_MS:-5000}"

args=(start --workspace "$workspace" --source "$source_name" --interval-ms "$interval_ms")

if [[ -n "${LOOP_GOAL:-}" ]]; then
  args+=(--goal "$LOOP_GOAL")
fi

if [[ -n "${LOOP_SCHEDULE:-}" ]]; then
  args+=(--schedule "$LOOP_SCHEDULE")
fi

if [[ -n "${LOOP_VERIFY:-}" ]]; then
  args+=(--verify "$LOOP_VERIFY")
fi

if [[ -n "${LOOP_EXECUTE:-}" ]]; then
  args+=(--execute "$LOOP_EXECUTE")
fi

if [[ "${LOOP_WORKTREE:-1}" == "1" ]]; then
  args+=(--worktree)
fi

if [[ "${LOOP_STOP_WHEN_IDLE:-0}" == "1" ]]; then
  args+=(--stop-when-idle)
fi

exec "$script_dir/osstack-loop.sh" "${args[@]}" "$@"
