#!/usr/bin/env bash
set -euo pipefail

# Continuous bronze-only chain sync: every run polls Blockmachine for
# whatever blocks are new since the last checkpoint (no TO_BLOCK — always
# catches up to the current chain head) and writes them to R2 as raw
# bronze. That's it — nothing here decodes or materializes anything.
#
# chain:materialize-silver (packages/pipeline) is a separate, unrelated
# step that turns raw bronze into the chart data. Run it wherever/whenever
# you want fresh charts — it just reads the same R2 bucket this keeps
# topped up. It is NOT part of this script and doesn't need to run here.
#
# CAVEAT: shares the chain backfill checkpoint (in R2, or locally in dev —
# see chain/r2Checkpoint.ts) with any other `chain:backfill`/`sync-bronze.sh`
# run against the same bucket, on this machine or another. Never run two at
# once — last write wins, no locking across machines, only within one
# (the flock below).
# 
# Recommended runner: systemd timer, see deploy/tao-sync.{service,timer} —
# follow logs live with `journalctl -u tao-sync -f`.

cd "$(dirname "${BASH_SOURCE[0]}")"

# Prevent overlapping runs if invoked manually while a scheduled run (or a
# slow catch-up after downtime) is still going.
LOCK_FD=200
exec 200>/tmp/tao-sync-bronze.lock
if ! flock -n "$LOCK_FD"; then
  echo "$(date -Iseconds) sync already running elsewhere, skipping this run" >&2
  exit 0
fi

log() { echo "$(date -Iseconds) $*"; }

set -a
[ -f .env ] && source .env
set +a

log "=== bronze sync start ==="

# The checkpoint lives in R2 (chain/meta/backfill_checkpoint.json) whenever
# BRONZE_URI is s3://, which is what makes this script safe to run on any
# machine with the right .env — no checkpoint file to copy over first. Only
# a local-path BRONZE_URI (dev only) falls back to a local checkpoint file,
# and even that just starts from block 1 if it's missing rather than erroring.
NEXT_FROM_BLOCK=$(pnpm --silent --filter @tao-tools/ingest run chain:next-from-block)
if ! [[ "$NEXT_FROM_BLOCK" =~ ^[0-9]+$ ]]; then
  log "ERROR: chain:next-from-block didn't print a number (got: $NEXT_FROM_BLOCK)"
  exit 1
fi

log "chain:backfill from block $NEXT_FROM_BLOCK to current chain head"
FROM_BLOCK="$NEXT_FROM_BLOCK" \
CHAIN_CHUNK_BLOCKS="${CHAIN_CHUNK_BLOCKS:-5000}" \
CHAIN_MAX_RPM="${CHAIN_MAX_RPM:-2000}" \
CHAIN_CONCURRENCY="${CHAIN_CONCURRENCY:-10}" \
  pnpm --filter @tao-tools/ingest run chain:backfill

log "=== bronze sync complete ==="
