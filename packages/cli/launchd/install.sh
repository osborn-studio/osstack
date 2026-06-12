#!/usr/bin/env bash
# Render the osstack daemon launchd plist with absolute paths and load it.
# Idempotent: re-running upgrades the existing plist and reloads.
#
# Usage:
#   bash packages/cli/launchd/install.sh
# Env overrides:
#   OSSTACK_HOME (default ~/.osstack)
#   HERMES_HOME  (default ~/.hermes)
#   HERMES_AGENT_HOME (hermes-agent repo root, default ~/hermes-agent)
#   NODE_BIN     (default `which node`)

set -euo pipefail

LABEL="ai.osstack.daemon"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ai.osstack.daemon.plist.template"
[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

OSSTACK_HOME="${OSSTACK_HOME:-${HOME}/.osstack}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
HERMES_AGENT_HOME="${HERMES_AGENT_HOME:-${HOME}/hermes-agent}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Set NODE_BIN=/abs/path/to/node." >&2
  exit 1
fi

# Resolve osstack/cli dist/bin.js. Try (a) the binary on PATH, (b) the repo build.
OSSTACK_JS=""
if command -v osstack >/dev/null 2>&1; then
  # osstack on PATH is a tsup-built ESM file (no separate wrapper).
  OSSTACK_JS="$(readlink -f "$(command -v osstack)")"
fi
if [ -z "$OSSTACK_JS" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  CANDIDATE="${REPO_ROOT}/packages/cli/dist/bin.js"
  if [ -f "$CANDIDATE" ]; then
    OSSTACK_JS="$CANDIDATE"
  fi
fi
if [ -z "$OSSTACK_JS" ] || [ ! -f "$OSSTACK_JS" ]; then
  echo "ERROR: could not locate osstack dist/bin.js. Run \`pnpm build\` or set OSSTACK_JS." >&2
  exit 1
fi

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
mkdir -p "${OSSTACK_HOME}/logs" "${PLIST_DIR}"

# Carry common bins on PATH so adapters (Codex, ripgrep, etc.) work from launchd.
DAEMON_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin:$(dirname "$NODE_BIN")"

sed \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{OSSTACK_JS}}|${OSSTACK_JS}|g" \
  -e "s|{{OSSTACK_HOME}}|${OSSTACK_HOME}|g" \
  -e "s|{{HERMES_HOME}}|${HERMES_HOME}|g" \
  -e "s|{{HERMES_AGENT_HOME}}|${HERMES_AGENT_HOME}|g" \
  -e "s|{{PATH}}|${DAEMON_PATH}|g" \
  "$TEMPLATE" > "$PLIST_PATH"

# Reload if already loaded.
if launchctl list | grep -q "^[0-9-]*[[:space:]]*[0-9-]*[[:space:]]*${LABEL}$"; then
  echo "Unloading existing ${LABEL}..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

echo "Loading ${LABEL} from ${PLIST_PATH}..."
launchctl load "$PLIST_PATH"

# Brief readiness probe.
SOCK="${OSSTACK_SOCKET:-${OSSTACK_HOME:-${HOME}/.osstack}/daemon.sock}"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$SOCK" ] && break
  sleep 0.3
done
if [ -S "$SOCK" ]; then
  echo "ok: daemon socket up at $SOCK"
  echo "Try: osstack health"
else
  echo "WARNING: socket not present after 3s. Check logs at ${OSSTACK_HOME}/logs/daemon.error.log" >&2
  exit 1
fi
