#!/usr/bin/env bash
set -euo pipefail

readonly REPO=osborn-studio/osstack-bridge-sandbox
if (( $# > 1 )) || { (( $# == 1 )) && ! [[ $1 =~ ^[1-9][0-9]{0,8}$ ]]; }; then
  echo 'Usage: dispatch-verify.sh [pr]' >&2
  exit 2
fi
if ! command -v gh >/dev/null || ! command -v jq >/dev/null; then
  echo '{"action":"failed","reason":"missing_tool"}'
  exit 2
fi

read_failed() {
  jq -nc '{action:"failed",reason:"read_failed"}'
  exit 1
}

report() {
  jq -nc --argjson pr "$pr" --arg head "$head" --arg action "$1" --arg reason "${2:-}" '
    {pr:$pr, head:($head | select(. != "") // null), action:$action,
     reason:($reason | select(. != "") // null)}'
}

umask 077
STATE_DIR=${OSSTACK_DISPATCH_STATE_DIR:-"$HOME/.local/state/osstack-verify-dispatch"}
mkdir -p -m 700 "$STATE_DIR"

# Reduce the complete API response to validated fields before entering the dispatch loop.
if (( $# == 1 )); then
  request=(api "repos/$REPO/pulls/$1")
else
  request=(api --paginate "repos/$REPO/pulls?state=open&per_page=100")
fi
rows=$(gh "${request[@]}" 2>/dev/null | jq -rs --arg repo "$REPO" --arg single "${1:-}" '
  def valid($pattern): type == "string" and test($pattern);
  if $single == "" then
    if length > 0 and all(.[]; type == "array") then .[][] else error("pages") end
  else
    if length == 1 and (.[0].number | tostring) == $single then .[0] else error("pr") end
  end
  | if (.number | type == "number" and (tostring | valid("\\A[1-9][0-9]{0,8}\\z")))
    then . else error("pr") end
  | (.head.sha | select(valid("\\A[0-9a-fA-F]{40}\\z")) // "") as $head
  | [.number, (.state == "open" and .draft == false and .base.repo.full_name == $repo
      and .head.repo.full_name == .base.repo.full_name
      and (.head.ref | valid("\\Aosstack/mission/[A-Za-z0-9_.-]+\\z"))
      and (.base.repo.default_branch | type == "string" and length > 0)
      and .base.ref == .base.repo.default_branch and $head != ""), $head] | @tsv
' 2>/dev/null) || read_failed

attempts=0
status=0
while IFS=$'\t' read -r pr eligible head; do
  [[ -n $pr ]] || continue
  if [[ $eligible != true ]]; then
    report skipped not_eligible
    continue
  fi
  verified=$(gh api --paginate "repos/$REPO/commits/$head/check-runs?check_name=osstack/verify-actions&filter=all" 2>/dev/null |
    jq -rs 'if length > 0 and all(.[]; .check_runs | type == "array")
      then any(.[].check_runs[]; .app.id == 15368) else error("checks") end' 2>/dev/null) || read_failed
  if [[ $verified == true ]]; then
    report skipped already_verified
    continue
  fi
  marker="$STATE_DIR/$pr-$head"
  if [[ -f $marker ]]; then
    modified=$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker")
    if (( $(date +%s) - modified < 45 * 60 )); then
      report skipped recently_dispatched
      continue
    fi
  fi
  if (( attempts >= 5 )); then
    report deferred dispatch_limit
    continue
  fi
  attempts=$((attempts + 1))
  if gh workflow run osstack-verify.yml -R osborn-studio/osstack-bridge-sandbox --ref main -f "pr=$pr" >/dev/null 2>&1; then
    touch "$marker"
    report dispatched
  else
    report failed dispatch_failed
    status=1
  fi
done <<< "$rows"
exit "$status"
