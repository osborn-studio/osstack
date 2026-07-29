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
#   OSSTACK_JS   (absolute stable-serving dist/bin.js; explicit checkout opt-in)
#   OSSTACK_AGENT_PROFILE (default mac-mini)
#   OSSTACK_WRITE_CONCURRENCY (default 2)
#   OSSTACK_READ_CONCURRENCY (default 8)
#   OSSTACK_POWER_POLICY (none or process_assertion; default none)

set -euo pipefail

LABEL="ai.osstack.daemon"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ai.osstack.daemon.plist.template"
[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 1; }

OSSTACK_HOME="${OSSTACK_HOME:-${HOME}/.osstack}"
OSSTACK_SOCKET="${OSSTACK_SOCKET:-${OSSTACK_HOME}/daemon.sock}"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
HERMES_AGENT_HOME="${HERMES_AGENT_HOME:-${HOME}/hermes-agent}"
OSSTACK_AGENT_PROFILE="${OSSTACK_AGENT_PROFILE:-mac-mini}"
OSSTACK_WRITE_CONCURRENCY="${OSSTACK_WRITE_CONCURRENCY:-2}"
OSSTACK_READ_CONCURRENCY="${OSSTACK_READ_CONCURRENCY:-8}"
OSSTACK_POWER_POLICY="${OSSTACK_POWER_POLICY:-none}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Set NODE_BIN=/abs/path/to/node." >&2
  exit 1
fi

case "$OSSTACK_AGENT_PROFILE" in
  ""|*[!A-Za-z0-9._-]*)
    echo "ERROR: OSSTACK_AGENT_PROFILE must be an identifier." >&2
    exit 1
    ;;
esac
for VALUE in "$OSSTACK_WRITE_CONCURRENCY" "$OSSTACK_READ_CONCURRENCY"; do
  case "$VALUE" in
    ""|0*|*[!0-9]*) echo "ERROR: concurrency values must be positive integers." >&2; exit 1 ;;
  esac
  if [ "$VALUE" -gt 64 ]; then
    echo "ERROR: concurrency values must not exceed 64." >&2
    exit 1
  fi
done
case "$OSSTACK_POWER_POLICY" in
  none|process_assertion) ;;
  *)
    echo "ERROR: OSSTACK_POWER_POLICY must be none or process_assertion; persistent pmset settings are never changed." >&2
    exit 1
    ;;
esac

# A checkout dist is never selected implicitly. OSSTACK_JS is the explicit
# operator/deploy escape hatch; otherwise use the installed osstack on PATH.
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

# Control-plane role provisioning (G1.2 round-3 F5): the boot guard refuses an
# undeclared module dir on the default home; declare this deployment.
ROLE_FILE="$(dirname "$OSSTACK_JS")/control-plane.json"
if [ ! -f "$ROLE_FILE" ]; then
  SCHEMA_V="$("$NODE_BIN" -e '
    const { createRequire } = require("node:module");
    const { pathToFileURL } = require("node:url");
    const requireFromCli = createRequire(process.argv[1]);
    import(pathToFileURL(requireFromCli.resolve("@osstack/core")).href)
      .then((module) => {
        if (!Number.isInteger(module.CURRENT_SCHEMA_VERSION)) process.exit(1);
        console.log(module.CURRENT_SCHEMA_VERSION);
      })
      .catch(() => process.exit(1));
  ' "$OSSTACK_JS")" || {
    echo "ERROR: could not resolve the schema version from the stable CLI." >&2
    exit 1
  }
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [file, home, rawSchema] = process.argv.slice(1);
    const schema = Number(rawSchema);
    fs.writeFileSync(file, `${JSON.stringify({
      role: "stable-serving",
      allowed_osstack_homes: [home],
      schema: { min: schema, max: schema },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  ' "$ROLE_FILE" "$OSSTACK_HOME" "$SCHEMA_V"
  echo "control-plane guard: wrote stable-serving role declaration at $ROLE_FILE"
fi

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
mkdir -p "${OSSTACK_HOME}/logs" "${PLIST_DIR}"

# Carry common bins on PATH so adapters (Codex, ripgrep, etc.) work from launchd.
DAEMON_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin"

"$NODE_BIN" - \
  "$TEMPLATE" "$PLIST_PATH" \
  "$NODE_BIN" "$OSSTACK_JS" "$OSSTACK_HOME" "$OSSTACK_SOCKET" \
  "$OSSTACK_AGENT_PROFILE" "$OSSTACK_WRITE_CONCURRENCY" \
  "$OSSTACK_READ_CONCURRENCY" "$OSSTACK_POWER_POLICY" \
  "$HERMES_HOME" "$HERMES_AGENT_HOME" \
  "$DAEMON_PATH" <<'NODE'
const fs = require("node:fs");
const [
  templatePath,
  plistPath,
  nodeBin,
  osstackJs,
  home,
  socket,
  profile,
  writeConcurrency,
  readConcurrency,
  powerPolicy,
  hermesHome,
  hermesAgentHome,
  daemonPath,
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
  AGENT_PROFILE: profile,
  WRITE_CONCURRENCY: writeConcurrency,
  READ_CONCURRENCY: readConcurrency,
  POWER_POLICY: powerPolicy,
  HERMES_HOME: hermesHome,
  HERMES_AGENT_HOME: hermesAgentHome,
  PATH: daemonPath,
};
const previousPlist = fs.existsSync(plistPath)
  ? fs.readFileSync(plistPath, "utf8")
  : "";
const previousPowerMatch = previousPlist.match(
  /<key>OSSTACK_POWER_POLICY<\/key>\s*<string>([^<]*)<\/string>/,
);
const previousPowerPolicy =
  previousPowerMatch?.[1] === "process_assertion"
    ? "process_assertion"
    : "none";
let rendered = fs.readFileSync(templatePath, "utf8");
const powerPrefix = powerPolicy === "process_assertion"
  ? "    <string>/usr/bin/caffeinate</string>\n    <string>-ims</string>"
  : "";
rendered = rendered.replaceAll("{{POWER_PREFIX_XML}}", powerPrefix);
for (const [name, value] of Object.entries(replacements)) {
  rendered = rendered.replaceAll(`{{${name}}}`, escapeXml(value));
}
if (/\{\{[A-Z_]+\}\}/.test(rendered)) {
  throw new Error("unresolved launchd template placeholder");
}
fs.writeFileSync(plistPath, rendered, { encoding: "utf8", mode: 0o600 });
const hostDir = `${home}/host`;
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(`${hostDir}/power-policy.json`, `${JSON.stringify({
  schema_version: 1,
  selected_at: new Date().toISOString(),
  mode: powerPolicy,
  previous_mode: previousPowerPolicy,
  machine_settings_changed: false,
  current: powerPolicy === "process_assertion"
    ? "caffeinate -ims bound to ai.osstack.daemon lifetime"
    : "no OSStack power assertion",
  rollback: `re-run installer with OSSTACK_POWER_POLICY=${previousPowerPolicy}`,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
NODE

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
  echo "profile=${OSSTACK_AGENT_PROFILE} write_concurrency=${OSSTACK_WRITE_CONCURRENCY} read_concurrency=${OSSTACK_READ_CONCURRENCY} power_policy=${OSSTACK_POWER_POLICY}"
  echo "Try: osstack health"
else
  echo "WARNING: socket not present after 3s. Check logs at ${OSSTACK_HOME}/logs/daemon.error.log" >&2
  exit 1
fi
