# syntax=docker/dockerfile:1

# ─── deps stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

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
# NEXT_PUBLIC_API_URL must be set at build time if used in static rendering.
# The ARG lets `docker build --build-arg NEXT_PUBLIC_API_URL=...` override it;
# compose passes it via environment which Next.js picks up during `next build`.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN pnpm --filter @highwood/web build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

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

# Copy the Next.js build output (no public/ directory exists in this project)
COPY --from=build /repo/apps/web/.next /repo/apps/web/.next

# Copy workspace source packages that Next.js transpiles at runtime
COPY --from=build /repo/packages/contracts /repo/packages/contracts

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# .next/cache needs to be writable by the app user
RUN chown -R appuser:appgroup /repo/apps/web/.next
USER appuser

WORKDIR /repo/apps/web
EXPOSE 3001
CMD ["pnpm", "start"]
