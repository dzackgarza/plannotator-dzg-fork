#!/usr/bin/env bash
# Thin wrapper that runs the NIM-12 umbrella proof gate via Bun.
#
# Usage:
#   ./scripts/run-proofs.sh             # run every NIM-13..NIM-21 proof
#   ./scripts/run-proofs.sh 13 17 21    # run only the listed slices
#   ./scripts/run-proofs.sh --bail      # stop on first failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
exec bun "$SCRIPT_DIR/run-proofs.ts" "$@"
