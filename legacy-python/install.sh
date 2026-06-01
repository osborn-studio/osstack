#!/usr/bin/env bash
# OSBStack installer — symlinks capabilities/ into ~/.osborn/capabilities/
# and exposes the eleven commands via ~/bin/.
#
# Idempotent. Re-running upgrades the symlinks. Does NOT modify shell rc files.

set -u

# Resolve the repo root from this script's location, so install.sh works from
# any cwd and through symlinks.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$HERE"

CAP_SRC="$REPO_ROOT/capabilities"
CAP_DST="$HOME/.osborn/capabilities"
BIN_DIR="$HOME/bin"

if [[ ! -d "$CAP_SRC" ]]; then
  echo "install.sh: $CAP_SRC not found — run from the OSBStack repo root?" >&2
  exit 2
fi

mkdir -p "$HOME/.osborn" "$BIN_DIR"

# ---------------------------------------------------------------
# Step 1: install capabilities tree
# ---------------------------------------------------------------
# We symlink the whole capabilities directory so updates flow via `git pull`.
# If ~/.osborn/capabilities/ already exists and is NOT our symlink, back it up.
if [[ -L "$CAP_DST" ]]; then
  current="$(readlink "$CAP_DST")"
  if [[ "$current" == "$CAP_SRC" ]]; then
    echo "OK   capabilities symlink already points at $CAP_SRC"
  else
    echo "WARN $CAP_DST is a symlink to $current — replacing"
    rm "$CAP_DST"
    ln -s "$CAP_SRC" "$CAP_DST"
    echo "OK   replaced symlink: $CAP_DST -> $CAP_SRC"
  fi
elif [[ -d "$CAP_DST" ]]; then
  backup="$CAP_DST.backup.$(date +%Y%m%d-%H%M%S)"
  echo "WARN $CAP_DST exists as a real directory — moving to $backup"
  mv "$CAP_DST" "$backup"
  ln -s "$CAP_SRC" "$CAP_DST"
  echo "OK   linked: $CAP_DST -> $CAP_SRC"
else
  ln -s "$CAP_SRC" "$CAP_DST"
  echo "OK   linked: $CAP_DST -> $CAP_SRC"
fi

# ---------------------------------------------------------------
# Step 2: ensure scripts are executable
# ---------------------------------------------------------------
chmod +x \
  "$CAP_SRC/osb-project/bin/osb-init" \
  "$CAP_SRC/osb-project/bin/osb-context" \
  "$CAP_SRC/deepseek/bin/ds-review" \
  "$CAP_SRC/deepseek/bin/ds-verify" \
  "$CAP_SRC/runtime/bin/osb-runtime" \
  "$CAP_SRC/runtime/bin/osb-loop" \
  "$CAP_SRC/runtime/bin/osb-agent-brief" \
  "$CAP_SRC/task/bin/osb-task" \
  "$CAP_SRC/workflow/bin/osb-run" \
  "$CAP_SRC/workflow/bin/osb-architecture-sync" \
  "$CAP_SRC/workflow/bin/osb-release-check" \
  "$CAP_SRC/osbstack/bin/osbstack"

# ---------------------------------------------------------------
# Step 3: install ~/bin/ symlinks
# ---------------------------------------------------------------
declare -a LINKS=(
  "osb-init:osb-project/bin/osb-init"
  "osb-context:osb-project/bin/osb-context"
  "ds-review:deepseek/bin/ds-review"
  "ds-verify:deepseek/bin/ds-verify"
  "osb-runtime:runtime/bin/osb-runtime"
  "osb-loop:runtime/bin/osb-loop"
  "osb-agent-brief:runtime/bin/osb-agent-brief"
  "osb-task:task/bin/osb-task"
  "osb-run:workflow/bin/osb-run"
  "osb-architecture-sync:workflow/bin/osb-architecture-sync"
  "osb-release-check:workflow/bin/osb-release-check"
  "osbstack:osbstack/bin/osbstack"
)

for entry in "${LINKS[@]}"; do
  name="${entry%%:*}"
  rel="${entry#*:}"
  target="$CAP_DST/$rel"
  link="$BIN_DIR/$name"
  ln -sf "$target" "$link"
  echo "OK   $link -> $target"
done

# ---------------------------------------------------------------
# Step 4: PATH check (do NOT modify rc files)
# ---------------------------------------------------------------
echo
case ":$PATH:" in
  *":$HOME/bin:"*)
    echo "OK   $HOME/bin is already in PATH"
    ;;
  *)
    cat <<EOF
WARN $HOME/bin is NOT in PATH on this shell.

To use the short forms (osb-init, ds-review, …) directly, add this to your
shell rc file (~/.zshrc for zsh, ~/.bashrc for bash):

    export PATH="\$HOME/bin:\$PATH"

…or, since \$HOME/.local/bin is already in PATH on this system, you can
mirror the symlinks there:

    mkdir -p \$HOME/.local/bin
    for f in \$HOME/bin/{osb-*,ds-*,osbstack}; do
      ln -sf "\$f" "\$HOME/.local/bin/\$(basename "\$f")"
    done

install.sh deliberately does not modify rc files. Pick the option you prefer.
EOF
    ;;
esac

# ---------------------------------------------------------------
# Step 5: report
# ---------------------------------------------------------------
echo
echo "Done. OSBStack 11 commands installed:"
for entry in "${LINKS[@]}"; do
  name="${entry%%:*}"
  printf "  %s\n" "$name"
done
echo
echo "Try:    osbstack help"
echo "Set:    export DEEPSEEK_API_KEY=...   (required for ds-review / ds-verify)"
