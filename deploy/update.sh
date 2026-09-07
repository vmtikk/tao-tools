#!/usr/bin/env bash
set -euo pipefail

# Run ON the server to pick up code changes. Pulls the sparse checkout
# (packages/core + packages/ingest + root config only — see the README's
# "Continuous bronze sync" section for the one-time clone/sparse-checkout
# setup) and rebuilds just those two packages.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

git pull
pnpm install --filter @tao-tools/ingest...
pnpm --filter @tao-tools/ingest... run build

echo "Updated. sync-bronze.sh will pick up the new build on its next scheduled run."
