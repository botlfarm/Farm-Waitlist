ARG BUILD_FROM=node:22-bookworm-slim

# Stage 1: Native build stage (compiles better-sqlite3 on aarch64 & amd64 + bundles frontend/server)
FROM ${BUILD_FROM} AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Build Vite SPA (base: './' for HA Ingress) and bundle server entrypoint
RUN npm run build \
 && npx esbuild server.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/server.mjs \
 && npm prune --omit=dev

# Stage 2: Lean production runtime
FROM ${BUILD_FROM} AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    jq \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=America/New_York \
    DB_PATH=/data/waitlist.db \
    BACKUP_DIR=/data/backups \
    HA_OPTIONS_PATH=/data/options.json

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY farm-waitlist/run.sh /run.sh

RUN chmod +x /run.sh

EXPOSE 3000

CMD ["/run.sh"]
