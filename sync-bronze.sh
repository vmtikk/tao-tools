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
# CAVEAT: shares data/meta/chain_backfill_checkpoint.json with a manual
# one-off `chain:backfill` run. Never run both at once.
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

CHECKPOINT_FILE="${DATA_ROOT:-$(pwd)/data}/meta/chain_backfill_checkpoint.json"
if [ ! -f "$CHECKPOINT_FILE" ]; then
  log "ERROR: no checkpoint at $CHECKPOINT_FILE — copy it over from wherever the initial 'pnpm chain:backfill' ran (see deploy/push-to-server.sh), or run that once here first."
  exit 1
fi

NEXT_FROM_BLOCK=$(node -e "
  const c = JSON.parse(require('fs').readFileSync('$CHECKPOINT_FILE', 'utf-8'));
  console.log(c.lastCompletedBlock + 1);
")

log "chain:backfill from block $NEXT_FROM_BLOCK to current chain head"
FROM_BLOCK="$NEXT_FROM_BLOCK" \
CHAIN_CHUNK_BLOCKS="${CHAIN_CHUNK_BLOCKS:-5000}" \
CHAIN_MAX_RPM="${CHAIN_MAX_RPM:-2000}" \
CHAIN_CONCURRENCY="${CHAIN_CONCURRENCY:-10}" \
  pnpm --filter @tao-tools/ingest run chain:backfill

log "=== bronze sync complete ==="
