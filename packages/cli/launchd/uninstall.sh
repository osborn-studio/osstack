#!/usr/bin/env bash
# Unload the osstack daemon and remove its LaunchAgent plist.
set -euo pipefail

LABEL="ai.osstack.daemon"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed: $PLIST_PATH"
else
  echo "no plist at $PLIST_PATH — nothing to do"
fi

SOCK="${OSSTACK_SOCKET:-/tmp/osstack.sock}"
[ -S "$SOCK" ] && rm -f "$SOCK"
echo "Daemon stopped. (Data at ~/.osstack and ~/.hermes is untouched.)"
