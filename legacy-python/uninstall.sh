#!/usr/bin/env bash
# OSBStack uninstaller — removes ~/bin symlinks and the
# ~/.osborn/capabilities/ symlink. Does NOT delete the repo or your projects.

set -u

CAP_DST="$HOME/.osborn/capabilities"
BIN_DIR="$HOME/bin"

LINKS=(
  osb-init osb-context
  ds-review ds-verify
  osb-runtime osb-loop osb-agent-brief
  osb-task
  osb-run osb-architecture-sync osb-release-check
  osbstack
)

for name in "${LINKS[@]}"; do
  link="$BIN_DIR/$name"
  if [[ -L "$link" ]]; then
    rm "$link"
    echo "REMOVE $link"
  elif [[ -e "$link" ]]; then
    echo "SKIP   $link (not a symlink — leaving alone)"
  fi
done

if [[ -L "$CAP_DST" ]]; then
  rm "$CAP_DST"
  echo "REMOVE $CAP_DST (symlink)"
elif [[ -d "$CAP_DST" ]]; then
  echo "SKIP   $CAP_DST (real directory — leaving alone)"
fi

echo
echo "Done. The repo at \$(pwd) is untouched."
echo "To remove it entirely:  rm -rf \"\$(pwd)\""
