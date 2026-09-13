#!/usr/bin/env bash
set -euo pipefail

# Continuous Google Trends sync: every run re-fetches the entire configured
# date range for every keyword in packages/ingest/src/social/trendsKeywords.ts
# (no API key, no quota) and writes it to bronze, keyed by today's date. This
# is correct, not wasteful re-fetching — Trends has no "give me just the new
# points" endpoint, and Google renormalizes the whole 0-100 scale against the
# query's current end date every time anyway (see
# packages/ingest/src/social/trendsClient.ts's docstring), so "refresh" and
# "backfill" are genuinely the same operation. Nothing here touches
# silver/gold; that's a separate, unrelated step (same split as
# sync-bronze.sh vs chain:materialize-silver).
#
# Stateless, like sync-youtube.sh: no checkpoint file, each run just writes
# bronze/social/google_trends/<keyword-slug>/<today's date>.parquet. Meant to
# run once a day (see deploy/tao-sync-trends.timer) — Trends itself only has
# weekly resolution for a range this long, so running more than once a day
# buys nothing beyond picking up the current partial week's latest number a
# little sooner.
#
# This is the flakiest sync of the three (chain/youtube/trends) — the
# endpoints are unofficial and undocumented, and can return HTML error pages
# instead of JSON if Google changes its frontend or rate-limits this
# server's IP. A failed run here should NOT be treated as urgent the way a
# failed chain or YouTube sync would be; check
# `journalctl -u tao-sync-trends` occasionally, don't page on it.
#
# Recommended runner: systemd timer, see
# deploy/tao-sync-trends.{service,timer} — follow logs live with
# `journalctl -u tao-sync-trends -f`.

cd "$(dirname "${BASH_SOURCE[0]}")"

# Prevent overlapping runs if invoked manually while a scheduled run is
# still going.
LOCK_FD=200
exec 200>/tmp/tao-sync-trends.lock
if ! flock -n "$LOCK_FD"; then
  echo "$(date -Iseconds) sync already running elsewhere, skipping this run" >&2
  exit 0
fi

log() { echo "$(date -Iseconds) $*"; }

set -a
[ -f .env ] && source .env
set +a

log "=== trends sync start ==="
pnpm --filter @tao-tools/ingest run trends:backfill
log "=== trends sync complete ==="
