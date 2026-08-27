# Built from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim AS base

# Stockfish comes from Debian rather than being vendored: the worker wants a native binary,
# and the browser gets its own WASM build. See ADR 0001.
RUN apt-get update \
  && apt-get install -y --no-install-recommends stockfish ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first, so a dependency-free change does not reinstall the world.
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/chess/package.json packages/chess/
COPY packages/chesscom/package.json packages/chesscom/
COPY packages/db/package.json packages/db/

RUN npm ci --omit=dev --workspace @chessedu/worker --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

ENV NODE_ENV=production
ENV STOCKFISH_PATH=/usr/games/stockfish

# No port: the worker only ever polls Postgres.
CMD ["npm", "run", "start", "--workspace", "@chessedu/worker"]
