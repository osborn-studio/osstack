#!/usr/bin/env bash
# Install V1 command shims that route through V2 (`osstack`) where possible.
#
# After running this, the old osb-* / ds-* names continue to work, but they
# print a deprecation notice and either:
#   (a) call into the equivalent osstack subcommand, OR
#   (b) call the original V1 Python script that still lives under this dir.
#
# Usage:
#   bash legacy-python/install-v1-shims.sh [target-bin-dir]
# Default target: ~/bin

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY_DIR="${REPO_ROOT}/legacy-python"
TARGET="${1:-${HOME}/bin}"
mkdir -p "$TARGET"

# Map: V1 command  →  shim body
#   "osstack"          → routes to osstack (canonical, was umbrella in V1 too)
#   osb-init           → osstack init
#   osb-context        → legacy-python/osb-project/bin/osb-context   (no V2 yet)
#   ds-review          → legacy-python/deepseek/bin/ds-review        (no V2 yet)
#   ...etc.
#
# As V2 grows, the routing in here gets cut over.

write_shim() {
  local name="$1"; local body="$2"
  local out="${TARGET}/${name}"
  cat > "$out" <<EOF
#!/usr/bin/env bash
# osstack V1-shim for ${name}. Installed by legacy-python/install-v1-shims.sh.
echo "osstack: deprecation notice — ${name} is a V1 command, routed through V2 shim." >&2
${body}
EOF
  chmod +x "$out"
  echo "  ${out}"
}

write_shim "osb-init"               "exec osstack init \"\$@\""
write_shim "osb-context"            "exec '${LEGACY_DIR}/osb-project/bin/osb-context' \"\$@\""
write_shim "osb-task"               "exec '${LEGACY_DIR}/task/bin/osb-task' \"\$@\" 2>/dev/null || exec osstack task \"\$@\""
write_shim "osb-runtime"            "exec '${LEGACY_DIR}/runtime/bin/osb-runtime' \"\$@\""
write_shim "osb-loop"               "exec '${LEGACY_DIR}/runtime/bin/osb-loop' \"\$@\""
write_shim "osb-agent-brief"        "exec '${LEGACY_DIR}/runtime/bin/osb-agent-brief' \"\$@\""
write_shim "osb-run"                "exec '${LEGACY_DIR}/workflow/bin/osb-run' \"\$@\""
write_shim "osb-architecture-sync"  "exec '${LEGACY_DIR}/workflow/bin/osb-architecture-sync' \"\$@\""
write_shim "osb-release-check"      "exec '${LEGACY_DIR}/workflow/bin/osb-release-check' \"\$@\""
write_shim "ds-review"              "exec '${LEGACY_DIR}/deepseek/bin/ds-review' \"\$@\""
write_shim "ds-verify"              "exec '${LEGACY_DIR}/deepseek/bin/ds-verify' \"\$@\""

cat <<EOF

Installed 11 V1 shims into ${TARGET}.
Ensure ${TARGET} is on \$PATH (already there for most setups).

As V2 grows, individual shims will cut over to native osstack subcommands.
Track progress at: docs/V2_REFACTOR_PLAN.md (see "V1 shim" rows).
EOF
