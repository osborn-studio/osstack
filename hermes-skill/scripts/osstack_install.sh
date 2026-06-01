#!/usr/bin/env bash
# osstack_install.sh — link the osstack Hermes skill into ~/.hermes/
#
# Usage:
#   bash hermes-skill/scripts/osstack_install.sh
#
# This creates a symlink so the Hermes skill at
# ~/.hermes/skills/software-development/osstack
# points back to this repo's hermes-skill/ directory.
# Editing files in the repo is reflected immediately in Hermes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_SRC="${REPO_ROOT}/hermes-skill"
HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
SKILL_DEST="${HERMES_HOME}/skills/software-development/osstack"

if [[ ! -d "${HERMES_HOME}" ]]; then
  echo "ERROR: HERMES_HOME (${HERMES_HOME}) does not exist." >&2
  echo "Install Hermes Agent first or set HERMES_HOME=/path/to/hermes." >&2
  exit 1
fi

mkdir -p "${HERMES_HOME}/skills/software-development"

# Detect existing install
if [[ -L "${SKILL_DEST}" ]]; then
  existing="$(readlink "${SKILL_DEST}")"
  if [[ "${existing}" == "${SKILL_SRC}" ]]; then
    echo "osstack skill already linked: ${SKILL_DEST} -> ${SKILL_SRC}"
    exit 0
  fi
  echo "WARNING: ${SKILL_DEST} is a symlink to ${existing}, replacing."
  rm "${SKILL_DEST}"
elif [[ -d "${SKILL_DEST}" || -f "${SKILL_DEST}" ]]; then
  echo "ERROR: ${SKILL_DEST} exists and is not a symlink." >&2
  echo "Move it aside first if you want to relink to this repo." >&2
  exit 1
fi

ln -s "${SKILL_SRC}" "${SKILL_DEST}"
echo "Linked: ${SKILL_DEST} -> ${SKILL_SRC}"
echo
echo "Hermes will pick up this skill on its next session start."
echo "Test now with:"
echo "  python3 ${SKILL_DEST}/scripts/osstack_bridge.py health"
