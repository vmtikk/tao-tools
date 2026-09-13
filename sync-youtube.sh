#!/usr/bin/env bash
set -euo pipefail

# Continuous YouTube channel-stats sync: every run does one channels.list
# call (1 quota unit total, regardless of channel count — see
# packages/ingest/src/social/youtubeClient.ts) and writes today's cumulative
# view/sub/video counts to bronze. That's it — nothing here diffs anything
# into daily deltas or touches silver/gold; those are a separate,
# unrelated step (same split as sync-bronze.sh vs chain:materialize-silver).
#
# Stateless, unlike sync-bronze.sh: there's no checkpoint file, because each
# run just overwrites bronze/social/youtube_channel_stats/<today's date>.parquet.
# Meant to run once a day (see deploy/tao-sync-youtube.timer) — running it
# more than once on the same day is harmless (same file, later snapshot) but
# pointless, and running it less than once a day leaves a gap in the future
# daily-delta series.
#
# Recommended runner: systemd timer, see
# deploy/tao-sync-youtube.{service,timer} — follow logs live with
# `journalctl -u tao-sync-youtube -f`.

cd "$(dirname "${BASH_SOURCE[0]}")"

# Prevent overlapping runs if invoked manually while a scheduled run is
# still going.
LOCK_FD=200
exec 200>/tmp/tao-sync-youtube.lock
if ! flock -n "$LOCK_FD"; then
  echo "$(date -Iseconds) sync already running elsewhere, skipping this run" >&2
  exit 0
fi

log() { echo "$(date -Iseconds) $*"; }

set -a
[ -f .env ] && source .env
set +a

log "=== youtube sync start ==="
pnpm --filter @tao-tools/ingest run youtube:snapshot-channels
log "=== youtube sync complete ==="
