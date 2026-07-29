#!/usr/bin/env bash
# Render and load the ai.osstack.autoupgrade launchd job (weekly Saturday
# 09:00 `osstack upgrade --auto`). Idempotent.
#
# Usage:
#   bash packages/cli/launchd/install-autoupgrade.sh
# Env overrides:
#   OSSTACK_HOME (default ~/.osstack)
#   NODE_BIN     (default `which node`)
#   OSSTACK_JS   (absolute stable-serving dist/bin.js; explicit checkout opt-in)

set -euo pipefail

LABEL="ai.osstack.autoupgrade"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist.template"
[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

OSSTACK_HOME="${OSSTACK_HOME:-${HOME}/.osstack}"
OSSTACK_SOCKET="${OSSTACK_SOCKET:-${OSSTACK_HOME}/daemon.sock}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Set NODE_BIN=/abs/path/to/node." >&2
  exit 1
fi

OSSTACK_JS_EXPLICIT="${OSSTACK_JS:+1}"
OSSTACK_JS="${OSSTACK_JS:-}"
if [ -z "$OSSTACK_JS" ] && command -v osstack >/dev/null 2>&1; then
  OSSTACK_JS="$("$NODE_BIN" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v osstack)")"
fi
if [ -z "$OSSTACK_JS" ] || [ ! -f "$OSSTACK_JS" ]; then
  echo "ERROR: could not locate an installed osstack binary. Set OSSTACK_JS to an absolute stable-serving dist/bin.js." >&2
  exit 1
fi
case "$OSSTACK_JS" in
  /*) ;;
  *) echo "ERROR: OSSTACK_JS must be absolute." >&2; exit 1 ;;
esac
case "$OSSTACK_JS" in
  */packages/cli/dist/bin.js)
    if [ -z "$OSSTACK_JS_EXPLICIT" ]; then
      echo "ERROR: refusing implicit development packages/cli/dist/bin.js; set OSSTACK_JS explicitly to provision it as stable-serving." >&2
      exit 1
    fi
    ;;
esac

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
mkdir -p "${OSSTACK_HOME}/logs" "${PLIST_DIR}"

UPGRADE_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin"

"$NODE_BIN" - \
  "$TEMPLATE" "$PLIST_PATH" "$NODE_BIN" "$OSSTACK_JS" \
  "$OSSTACK_HOME" "$OSSTACK_SOCKET" "$UPGRADE_PATH" <<'NODE'
const fs = require("node:fs");
const [
  templatePath,
  plistPath,
  nodeBin,
  osstackJs,
  home,
  socket,
  upgradePath,
] = process.argv.slice(2);
const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const replacements = {
  NODE_BIN: nodeBin,
  OSSTACK_JS: osstackJs,
  OSSTACK_HOME: home,
  OSSTACK_SOCKET: socket,
  PATH: upgradePath,
};
let rendered = fs.readFileSync(templatePath, "utf8");
for (const [name, value] of Object.entries(replacements)) {
  rendered = rendered.replaceAll(`{{${name}}}`, escapeXml(value));
}
if (/\{\{[A-Z_]+\}\}/.test(rendered)) {
  throw new Error("unresolved launchd template placeholder");
}
fs.writeFileSync(plistPath, rendered, { encoding: "utf8", mode: 0o600 });
NODE

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "Unloading existing ${LABEL}..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

echo "Loading ${LABEL} from ${PLIST_PATH}..."
launchctl load "$PLIST_PATH"
echo "ok: ${LABEL} scheduled (Saturdays 09:00). Logs: ${OSSTACK_HOME}/logs/upgrade.log"
echo "Dry-run now with: osstack upgrade --dry-run"
