#!/usr/bin/env bash
# verify-osstack.sh — verification harness for the osstack CLI + daemon + cockpit.
# Verification scaffolding only: it never touches ~/.osstack or a reserved home.
#
# Usage (RUN_ID defaults to "default"; export it once per run):
#   verify-osstack.sh build                 # pnpm install --frozen-lockfile + build @osstack/cli and deps
#   verify-osstack.sh launch                # start an isolated daemon + dashboard, wait until usable
#   verify-osstack.sh doctor                # read-only: is this instance ours and worth driving?
#   verify-osstack.sh env                   # print the export lines for this run (eval "$(... env)")
#   verify-osstack.sh cli <label> -- <osstack args...>   # run osstack, record cmd/stdout/stderr/exit
#   verify-osstack.sh workspace [name]      # create a scratch git repo, print its path
#   verify-osstack.sh screenshot <label> [url-path] [wait-text]  # cockpit PNG/DOM/text over CDP + /api/dashboard JSON
#   verify-osstack.sh keep <label> <path>   # copy a scratch artifact (proof dir, report) into evidence
#   verify-osstack.sh cleanup               # stop only the daemon this run started, delete scratch, keep evidence
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN_ID="${RUN_ID:-default}"
SCRATCH="${OSSTACK_VERIFY_SCRATCH:-/tmp/osstack-verify}/$RUN_ID"
EVIDENCE="${OSSTACK_VERIFY_EVIDENCE:-$HOME/osstack-verify-evidence}/$RUN_ID"
BIN="$REPO/packages/cli/dist/bin.js"

die() { echo "verify-osstack: $*" >&2; exit 1; }

need_node() {
  command -v node >/dev/null || die "node not found (need >=22; pnpm 11 fails on node 20)"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node $(node -v) is too old; put node >=22 first on PATH"
}

port_file() { echo "$SCRATCH/port"; }

run_env() {
  [ -f "$(port_file)" ] || die "no launched instance for RUN_ID=$RUN_ID (run launch first)"
  export OSSTACK_HOME="$SCRATCH/home"
  export OSSTACK_SOCKET="$SCRATCH/daemon.sock"
  export OSSTACK_DASHBOARD_PORT="$(cat "$(port_file)")"
  export OSSTACK_DASHBOARD_HOST=127.0.0.1
  export OSSTACK_UPDATE_CHECK=0
}

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

cmd_build() {
  need_node
  cd "$REPO"
  pnpm install --frozen-lockfile
  # Shared/partial checkouts can leave *.tsbuildinfo while dist/index.js is gone;
  # tsc then skips emit and dependents fail with "Cannot find module '@osstack/...'".
  clear_stale_tsbuildinfo() {
    local f pkg
    while IFS= read -r -d '' f; do
      pkg="$(dirname "$f")"
      if [ -f "$pkg/src/index.ts" ] && [ ! -f "$pkg/dist/index.js" ]; then
        rm -f "$f"
      fi
    done < <(find packages -name 'tsconfig.tsbuildinfo' -print0 2>/dev/null)
  }
  clear_stale_tsbuildinfo
  if ! pnpm --filter "@osstack/cli..." build; then
    echo "verify-osstack: build failed; clearing all package tsbuildinfo and retrying once" >&2
    find packages -name 'tsconfig.tsbuildinfo' -delete
    pnpm --filter "@osstack/cli..." build
  fi
  node "$BIN" --version
}

cmd_launch() {
  need_node
  [ -f "$BIN" ] || die "$BIN missing; run: $0 build"
  if [ -f "$SCRATCH/daemon.pid" ] && kill -0 "$(cat "$SCRATCH/daemon.pid")" 2>/dev/null; then
    die "RUN_ID=$RUN_ID already has a daemon (pid $(cat "$SCRATCH/daemon.pid")); pick another RUN_ID or cleanup"
  fi
  mkdir -p "$SCRATCH/home" "$EVIDENCE"
  free_port > "$(port_file)"
  run_env
  nohup node "$BIN" serve > "$SCRATCH/serve.log" 2>&1 &
  echo $! > "$SCRATCH/daemon.pid"
  for _ in $(seq 1 60); do
    if grep -q "osstack daemon listening on" "$SCRATCH/serve.log" 2>/dev/null \
      && node "$BIN" health >/dev/null 2>&1 \
      && curl -fsS "http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/api/dashboard" >/dev/null 2>&1; then
      cp "$SCRATCH/serve.log" "$EVIDENCE/serve-launch.log"
      echo "ready: pid=$(cat "$SCRATCH/daemon.pid") socket=$OSSTACK_SOCKET dashboard=http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/dashboard evidence=$EVIDENCE"
      return 0
    fi
    kill -0 "$(cat "$SCRATCH/daemon.pid")" 2>/dev/null || { cat "$SCRATCH/serve.log" >&2; die "daemon exited during launch"; }
    sleep 0.5
  done
  cat "$SCRATCH/serve.log" >&2
  die "daemon not ready after 30s"
}

cmd_doctor() {
  run_env
  local ok=1 pid; pid="$(cat "$SCRATCH/daemon.pid" 2>/dev/null || echo)"
  check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; ok=0; fi; }
  check "daemon pid $pid alive" '[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null'
  check "pid runs this checkout's bin.js serve" 'tr "\0" " " < /proc/$pid/cmdline 2>/dev/null | grep -q "$BIN serve"'
  check "home is the scratch home, not ~/.osstack" '[ "$OSSTACK_HOME" = "$SCRATCH/home" ] && [ "$OSSTACK_HOME" != "$HOME/.osstack" ]'
  local health; health="$(node "$BIN" health 2>/dev/null || true)"
  check "health RPC ok" 'echo "$health" | grep -q "\"ok\": true"'
  check "health db_path inside scratch home" 'echo "$health" | grep -q "\"db_path\": \"$SCRATCH/home/state.db\""'
  check "daemon version == checkout version ($(node "$BIN" --version))" 'echo "$health" | grep -q "\"version\": \"$(node "$BIN" --version | cut -d" " -f2)\""'
  check "dashboard port $OSSTACK_DASHBOARD_PORT owned by pid $pid" 'ss -ltnp 2>/dev/null | grep ":$OSSTACK_DASHBOARD_PORT " | grep -q "pid=$pid,"'
  check "dashboard serves osstack Cockpit" 'curl -fsS "http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/dashboard" | grep -q "<title>osstack Cockpit</title>"'
  [ "$ok" = 1 ] && echo "doctor: healthy (RUN_ID=$RUN_ID)" || { echo "doctor: NOT healthy — do not drive"; return 1; }
}

cmd_env() {
  run_env
  echo "export OSSTACK_HOME='$OSSTACK_HOME' OSSTACK_SOCKET='$OSSTACK_SOCKET' OSSTACK_DASHBOARD_PORT='$OSSTACK_DASHBOARD_PORT' OSSTACK_DASHBOARD_HOST=127.0.0.1 OSSTACK_UPDATE_CHECK=0"
  echo "osstack() { node '$BIN' \"\$@\"; }"
}

cmd_cli() {
  local label="${1:?label required}"; shift
  [ "${1:-}" = "--" ] && shift
  run_env
  local dir="$EVIDENCE/cli"; mkdir -p "$dir"
  printf 'osstack' > "$dir/$label.cmd"; printf ' %q' "$@" >> "$dir/$label.cmd"; echo >> "$dir/$label.cmd"
  set +e
  node "$BIN" "$@" > "$dir/$label.stdout" 2> "$dir/$label.stderr"
  local code=$?
  set -e
  echo "$code" > "$dir/$label.exit"
  cat "$dir/$label.stdout"
  [ -s "$dir/$label.stderr" ] && sed 's/^/[stderr] /' "$dir/$label.stderr" >&2
  echo "[exit $code] evidence: $dir/$label.{cmd,stdout,stderr,exit}" >&2
  return "$code"
}

cmd_workspace() {
  local name="${1:-ws}" w="$SCRATCH/workspaces/${1:-ws}"
  mkdir -p "$w"
  if [ ! -d "$w/.git" ]; then
    git -C "$w" init -q -b main
    echo "osstack verification workspace" > "$w/README.md"
    git -C "$w" add README.md
    git -C "$w" -c user.name=osstack-verify -c user.email=osstack-verify@example.invalid commit -q -m init
  fi
  echo "$w"
}

cmd_screenshot() {
  local label="${1:?label required}" path="${2:-/dashboard}" wait="${3:-}"
  run_env
  mkdir -p "$EVIDENCE/ui"
  local url="http://127.0.0.1:$OSSTACK_DASHBOARD_PORT$path"
  curl -fsS "http://127.0.0.1:$OSSTACK_DASHBOARD_PORT/api/dashboard" > "$EVIDENCE/ui/$label.api-dashboard.json"
  # Chrome's one-shot --screenshot/--dump-dom hang on this cockpit (live polling); drive it over CDP instead.
  node "$(dirname "${BASH_SOURCE[0]}")/cockpit-capture.mjs" "$url" "$EVIDENCE/ui/$label" ${wait:+--wait-text "$wait"}
  echo "evidence: $EVIDENCE/ui/$label.api-dashboard.json"
}

cmd_keep() {
  local label="${1:?label required}" src="${2:?path required}"
  mkdir -p "$EVIDENCE/kept/$label"
  cp -a "$src" "$EVIDENCE/kept/$label/"
  echo "kept: $EVIDENCE/kept/$label/$(basename "$src")"
}

cmd_cleanup() {
  if [ -f "$SCRATCH/daemon.pid" ]; then
    local pid; pid="$(cat "$SCRATCH/daemon.pid")"
    if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$BIN serve"; then
      kill "$pid"
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
      echo "stopped daemon pid $pid"
    else
      echo "daemon pid $pid not running (or not ours); nothing to stop"
    fi
  fi
  if [ -d "$SCRATCH" ]; then
    mkdir -p "$EVIDENCE"
    [ -f "$SCRATCH/serve.log" ] && cp "$SCRATCH/serve.log" "$EVIDENCE/serve-final.log"
    rm -rf "$SCRATCH"
    echo "removed scratch $SCRATCH"
  fi
  echo "evidence kept: $EVIDENCE"
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  launch) shift; cmd_launch "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  env) shift; cmd_env "$@" ;;
  cli) shift; cmd_cli "$@" ;;
  workspace) shift; cmd_workspace "$@" ;;
  screenshot) shift; cmd_screenshot "$@" ;;
  keep) shift; cmd_keep "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
