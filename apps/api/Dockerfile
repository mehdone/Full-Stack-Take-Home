# syntax=docker/dockerfile:1

# ─── deps stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# Copy manifests first so layer cache is reused when source changes but deps don't
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/alerting/package.json apps/alerting/
COPY apps/consumer/package.json apps/consumer/
COPY apps/outbox-relay/package.json apps/outbox-relay/
COPY apps/system-alerts/package.json apps/system-alerts/
COPY apps/web/package.json apps/web/
COPY apps/etl/package.json apps/etl/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

RUN pnpm install --frozen-lockfile

# ─── build stage ──────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @highwood/api build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# Copy manifests and install prod deps only
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/alerting/package.json apps/alerting/
COPY apps/consumer/package.json apps/consumer/
COPY apps/outbox-relay/package.json apps/outbox-relay/
COPY apps/system-alerts/package.json apps/system-alerts/
COPY apps/web/package.json apps/web/
COPY apps/etl/package.json apps/etl/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

RUN pnpm install --frozen-lockfile --prod

# Copy the bundled output (workspace packages are inlined by tsup)
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
