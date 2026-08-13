#!/usr/bin/env bash
# IT / MDM offboarding helper — wipe personal amem data for the current user.
set -euo pipefail

AMEM_BIN="${AMEM_BIN:-amem}"

if command -v "$AMEM_BIN" >/dev/null 2>&1; then
  "$AMEM_BIN" wipe --all --yes || true
fi

# Belt-and-suspenders if the CLI was already uninstalled.
rm -rf "${AMEM_HOME:-$HOME/.amem}"

echo "amem offboard complete for ${USER:-unknown}"
