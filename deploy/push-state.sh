#!/usr/bin/env bash
set -euo pipefail

# One-time (or occasional) push of the local-only state that git can't
# carry: secrets and the chain-backfill checkpoint. Code now reaches the
# server via `git pull` (see deploy/update.sh) against a sparse checkout of
# packages/core + packages/ingest — this script is only for what's
# gitignored: .env and data/meta/chain_backfill_checkpoint.json (the tiny
# JSON file that tells sync-bronze.sh which block to resume from; without
# it, a fresh server would restart chain:backfill from block 1).
#
# Usage: deploy/push-state.sh user@host:/opt/tao-tools

TARGET="${1:?Usage: $0 user@host:/path/to/deploy}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rsync -avzR \
  .env \
  data/meta/chain_backfill_checkpoint.json \
  "$TARGET"

echo "Pushed .env + checkpoint. Code updates go through 'git pull' on the server (deploy/update.sh)."
