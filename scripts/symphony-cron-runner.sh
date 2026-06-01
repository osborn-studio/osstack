#!/usr/bin/env bash
# symphony-cron-runner.sh — Hermes cron entry point for Symphony watch.
#
# Idempotent. Runs the watcher, and if any drift is detected, fires
# notify-osborn.py with a concise summary so the user finds out without
# having to remember to run `osstack skills check`.
#
# Install as Hermes cron (weekly, Mon 9am):
#   hermes cron create --name osstack-symphony-watch --no-agent \
#     --script ~/Developer/osbstack/scripts/symphony-cron-runner.sh \
#     '0 9 * * 1'
#
# Or system crontab:
#   0 9 * * 1  bash ~/Developer/osbstack/scripts/symphony-cron-runner.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH="$REPO_ROOT/scripts/symphony-watch.sh"
NOTIFY="$REPO_ROOT/scripts/notify-osborn.py"

# Always pull so the analysis can reference real new commits.
OUTPUT=$(bash "$WATCH" --pull 2>&1 || true)

# Lines starting with ⚠ or "→ new commits:" mean something changed.
# Always ensure log dir + file exist so downstream `tail` doesn't fail.
mkdir -p "$HOME/.osstack/logs"
touch "$HOME/.osstack/logs/symphony-watch.log"

if echo "$OUTPUT" | grep -qE "(⚠|→ new commits:)"; then
  SUBJECT="osstack: openai/symphony 有新动作"
  BODY="$(printf 'Symphony 上游有变化，需要你的注意。\n\n%s\n\n下一步：\n  1. 查阅 docs/external/symphony-analysis.md\n  2. 若 SPEC 有实质变化，更新分析表第六节\n  3. 验收后执行：osstack skills bless openai-symphony\n' "$OUTPUT")"
  python3 "$NOTIFY" --subject "$SUBJECT" --body "$BODY" --severity warn
  printf '[%s] symphony-watch: DRIFT — notifier invoked\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" \
    >> "$HOME/.osstack/logs/symphony-watch.log"
else
  # Silent success — Hermes cron with --no-agent treats empty stdout as
  # no-notification. Log for audit so we know the cron ran.
  printf '[%s] symphony-watch: no drift (%s)\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" \
    "$(echo "$OUTPUT" | grep -m1 'local  HEAD' | sed 's/^ *//')" \
    >> "$HOME/.osstack/logs/symphony-watch.log"
fi
