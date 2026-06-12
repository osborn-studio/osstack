#!/usr/bin/env bash
# Render and load the ai.osstack.autoupgrade launchd job (weekly Saturday
# 09:00 `osstack upgrade --auto`). Idempotent.
#
# Usage:
#   bash packages/cli/launchd/install-autoupgrade.sh
# Env overrides:
#   OSSTACK_HOME (default ~/.osstack)
#   NODE_BIN     (default `which node`)

set -euo pipefail

LABEL="ai.osstack.autoupgrade"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist.template"
[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

OSSTACK_HOME="${OSSTACK_HOME:-${HOME}/.osstack}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Set NODE_BIN=/abs/path/to/node." >&2
  exit 1
fi

OSSTACK_JS=""
if command -v osstack >/dev/null 2>&1; then
  OSSTACK_JS="$(readlink -f "$(command -v osstack)")"
fi
if [ -z "$OSSTACK_JS" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  CANDIDATE="${REPO_ROOT}/packages/cli/dist/bin.js"
  [ -f "$CANDIDATE" ] && OSSTACK_JS="$CANDIDATE"
fi
if [ -z "$OSSTACK_JS" ] || [ ! -f "$OSSTACK_JS" ]; then
  echo "ERROR: could not locate osstack dist/bin.js. Run \`pnpm build\` or set OSSTACK_JS." >&2
  exit 1
fi

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
mkdir -p "${OSSTACK_HOME}/logs" "${PLIST_DIR}"

UPGRADE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_BIN")"

sed \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{OSSTACK_JS}}|${OSSTACK_JS}|g" \
  -e "s|{{OSSTACK_HOME}}|${OSSTACK_HOME}|g" \
  -e "s|{{PATH}}|${UPGRADE_PATH}|g" \
  "$TEMPLATE" > "$PLIST_PATH"

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "Unloading existing ${LABEL}..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

echo "Loading ${LABEL} from ${PLIST_PATH}..."
launchctl load "$PLIST_PATH"
echo "ok: ${LABEL} scheduled (Saturdays 09:00). Logs: ${OSSTACK_HOME}/logs/upgrade.log"
echo "Dry-run now with: osstack upgrade --dry-run"
