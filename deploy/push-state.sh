#!/usr/bin/env bash
set -euo pipefail

# One-time (or occasional) push of the local-only state that git can't
# carry: secrets. Code now reaches the server via `git pull` (see
# deploy/update.sh) against a sparse checkout of packages/core +
# packages/ingest — this script is only for .env (R2 + Blockmachine
# credentials, TAOSTATS/YOUTUBE keys, etc).
#
# The chain-backfill checkpoint does NOT need to be pushed anymore — it
# lives in R2 alongside bronze itself (chain/meta/backfill_checkpoint.json,
# see packages/ingest/src/chain/r2Checkpoint.ts), so any machine with a
# working .env resumes from the same state on its own. This script only
# matters for .env now; run it once per new machine, not on every sync.
#
# Usage: deploy/push-state.sh user@host:/opt/tao-tools

TARGET="${1:?Usage: $0 user@host:/path/to/deploy}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rsync -avzR \
  .env \
  "$TARGET"

echo "Pushed .env. Code updates go through 'git pull' on the server (deploy/update.sh)."
