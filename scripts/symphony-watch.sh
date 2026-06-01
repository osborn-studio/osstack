#!/usr/bin/env bash
# symphony-watch.sh — long-term tracking helper for openai/symphony.
#
# Usage:
#   bash scripts/symphony-watch.sh             # quick check + summary
#   bash scripts/symphony-watch.sh --pull      # also pull new commits
#   bash scripts/symphony-watch.sh --bless     # also bless current HEAD
#
# Suggested cron (via Hermes):
#   hermes cron add --schedule "0 9 * * 1" --name symphony-watch -- \
#     bash ~/Developer/osbstack/scripts/symphony-watch.sh

set -euo pipefail

CLONE_DIR="${HOME}/Developer/_external-refs/symphony"
REPO_URL="https://github.com/openai/symphony.git"
ANALYSIS_DOC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/external/symphony-analysis.md"

DO_PULL=0
DO_BLESS=0
for arg in "$@"; do
  case "$arg" in
    --pull)  DO_PULL=1 ;;
    --bless) DO_BLESS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Ensure clone exists.
if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "→ no local clone at $CLONE_DIR; cloning shallow..."
  mkdir -p "$(dirname "$CLONE_DIR")"
  git clone --depth 50 "$REPO_URL" "$CLONE_DIR"
fi

# Local-HEAD snapshot.
LOCAL_HEAD=$(git -C "$CLONE_DIR" rev-parse HEAD)
LOCAL_DATE=$(git -C "$CLONE_DIR" log -1 --format=%cd --date=short HEAD)

# Remote HEAD via ls-remote (no fetch needed).
REMOTE_HEAD=$(git ls-remote "$REPO_URL" main | cut -f1)

echo "Symphony tracking status:"
echo "  local  HEAD = ${LOCAL_HEAD:0:12}  ($LOCAL_DATE)"
echo "  remote HEAD = ${REMOTE_HEAD:0:12}"
echo "  analysis    = $ANALYSIS_DOC"
echo ""

# Compare blessed_sha from osstack manifest.
if command -v osstack >/dev/null 2>&1; then
  BLESSED=$(osstack skills list 2>/dev/null | awk '/openai-symphony/{getline; print}' | sed -n 's/.*blessed=\([^ ]*\).*/\1/p' || true)
elif command -v node >/dev/null 2>&1 && [[ -f "$HOME/Developer/osbstack/packages/cli/dist/bin.js" ]]; then
  BLESSED=$(node "$HOME/Developer/osbstack/packages/cli/dist/bin.js" skills list 2>/dev/null \
    | awk '/openai-symphony/{getline; print}' \
    | sed -n 's/.*blessed=\([^ ]*\).*/\1/p' || true)
else
  BLESSED=""
fi
[[ -n "$BLESSED" ]] && echo "  blessed (osstack manifest) = $BLESSED"

# Decide whether action is needed.
if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo ""
  echo "⚠  Remote has new commits not in local clone."
  if [[ $DO_PULL -eq 1 ]]; then
    echo "→ pulling..."
    git -C "$CLONE_DIR" fetch --depth 50 origin main
    git -C "$CLONE_DIR" reset --hard origin/main
    NEW_LOCAL=$(git -C "$CLONE_DIR" rev-parse HEAD)
    echo "→ local HEAD now = ${NEW_LOCAL:0:12}"
    echo ""
    echo "→ new commits:"
    git -C "$CLONE_DIR" log --oneline "${LOCAL_HEAD}..${NEW_LOCAL}" | head -20
    echo ""
    echo "→ files changed in SPEC.md / elixir/lib/:"
    git -C "$CLONE_DIR" diff --stat "${LOCAL_HEAD}..${NEW_LOCAL}" -- SPEC.md elixir/lib/ | head -30
    echo ""
    echo "NEXT: review changes and update $ANALYSIS_DOC"
    echo "      then: osstack skills bless openai-symphony"
  else
    echo "    Run with --pull to fetch + show changes:"
    echo "    bash $(basename "${BASH_SOURCE[0]}") --pull"
  fi
else
  echo "✓ local matches remote — no new upstream work."
fi

# Blessed-vs-remote drift signals "we haven't reviewed yet" even if local was pulled.
if [[ -n "$BLESSED" && "$BLESSED" != "$REMOTE_HEAD" && "$BLESSED" != "(none)" ]]; then
  echo ""
  echo "⚠  osstack manifest blessed=${BLESSED:0:12}  ≠  remote=${REMOTE_HEAD:0:12}"
  if [[ $DO_BLESS -eq 1 ]]; then
    osstack skills bless openai-symphony 2>/dev/null \
      || node "$HOME/Developer/osbstack/packages/cli/dist/bin.js" skills bless openai-symphony
  else
    echo "   Once analysis doc is up to date, run:"
    echo "   osstack skills bless openai-symphony"
  fi
fi

echo ""
echo "done."
