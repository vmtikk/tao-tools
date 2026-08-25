# Ingestion worker (tao-analytics-plan.md §2). Runs the ingest scripts against
# bronze (R2 in production, local disk in dev — see .env.example). Not needed
# to develop Phase 0 locally; this is what a scheduled/nightly run uses.
FROM node:22-slim

RUN corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/pipeline/package.json packages/pipeline/package.json

RUN pnpm install --frozen-lockfile --filter @tao-tools/ingest... --filter @tao-tools/pipeline...

COPY packages/core packages/core
COPY packages/ingest packages/ingest
COPY packages/pipeline packages/pipeline
COPY data/meta data/meta

CMD ["pnpm", "--filter", "@tao-tools/ingest", "run", "kraken:phase0"]
