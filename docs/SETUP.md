# Local setup

This document covers running the Highwood Emissions take-home locally — the API, consumer, outbox relay, system-alerts relay, metrics relay, alerting receiver, web dashboard, migrations, and tests. The challenge spec lives in [`README.md`](../README.md) and is untouched. For the "everything in containers" path, see [`DOCKER.md`](./DOCKER.md).

## Prerequisites

- **Node.js** 20.x or 22.x (the workspace uses Node-native TypeScript via `tsx`).
- **pnpm** 9.x. Install via `corepack enable && corepack prepare pnpm@latest --activate` or `npm i -g pnpm`.
- **Docker** with Compose v2. The infra stack (Postgres 16, Redis 7.4, Kafka 4.2 KRaft) runs in containers.

## One-time setup

```bash
cp .env.example .env       # defaults work out of the box
pnpm install               # installs all 11 workspace packages
```

## Bring up the infra

```bash
pnpm infra:up              # postgres + redis + kafka, detached
pnpm db:migrate            # runs all Drizzle migrations + creates the partitioned measurements table
```

Optional admin UIs (pgAdmin on `:5050`, kafka-ui on `:8080`):

```bash
pnpm infra:tools
```

**pgAdmin login** (defaults from `.env.example`; override via `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`):

| Field    | Value             |
| -------- | ----------------- |
| URL      | http://localhost:5050 |
| Email    | `admin@local.dev` |
| Password | `admin`           |

Once inside pgAdmin, add a server connection to Postgres using the credentials below (host = `postgres` from within the docker network, or `host.docker.internal` if pgAdmin runs outside compose). kafka-ui at `:8080` needs no auth — it auto-discovers the broker.

Default connection strings (from `.env.example`):

| Service  | URL / DSN                                                           |
| -------- | ------------------------------------------------------------------- |
| Postgres | `postgresql://emissions:emissions@localhost:5432/emissions`         |
| Redis    | `redis://localhost:6379`                                            |
| Kafka    | `localhost:9092`                                                    |

## Run the full stack

```bash
pnpm dev
```

This brings the infra up, runs migrations, then starts every app in parallel via `pnpm -r --parallel run dev`:

| App                   | Port  | Purpose                                                     |
| --------------------- | ----- | ----------------------------------------------------------- |
| `@highwood/api`       | 3000  | HTTP API — `POST /sites`, `POST /ingest`, `GET /sites`, `GET /sites/:slug/metrics`, `GET /health` |
| `@highwood/consumer`  | —     | Kafka consumer; drains `emissions.ingest.v1`, persists measurements + outbox row in one tx |
| `@highwood/outbox-relay` | 4101 (health) | Polls `outbox`, POSTs to alerting receiver, exp. backoff |
| `@highwood/system-alerts` | 4102 (health) | Same shape as outbox-relay but for `system_alerts` |
| `@highwood/metrics-relay` | 4103 (health) | Drains `metrics_outbox`; applies SETNX-guarded HINCRBYFLOAT to the per-site Redis hash (current-month cache) |
| `@highwood/alerting`  | 4100  | HTTP sink — `POST /alerts/business`, `POST /alerts/system` |
| `@highwood/web`       | 3001  | Next.js dashboard (sites table, create-site form, ingest form with retry UX) |

Individual apps (handy when iterating on one workspace):

```bash
pnpm --filter @highwood/api dev
pnpm --filter @highwood/consumer dev
pnpm --filter @highwood/web dev
pnpm dev:alerting          # shortcut
pnpm dev:outbox-relay
pnpm dev:system-alerts
pnpm dev:metrics-relay
```

## Migrations

```bash
pnpm db:generate           # emit a new migration from Drizzle schema diffs
pnpm db:migrate            # apply pending migrations (idempotent)
```

Schema lives in `packages/db/src/schema/`; the partitioning + indexes for `measurements` are applied via raw-SQL migrations included alongside the Drizzle output.

## Smoke check the API

```bash
# Create a site (re-POSTing the same slug returns a 409 CONFLICT envelope)
curl -X POST http://localhost:3000/sites \
  -H 'content-type: application/json' \
  -d '{
    "slug": "demo-site",
    "name": "Demo Site",
    "country": "US",
    "latitude": 40.0,
    "longitude": -105.0,
    "timezone": "America/Denver",
    "emission_limit": "1000.000000"
  }'

# Ingest a batch (epoch milliseconds — matches JS Date.now())
NOW_MS=$(node -e 'process.stdout.write(String(Date.now()))')
BATCH=$(uuidgen | tr A-Z a-z)
curl -X POST http://localhost:3000/ingest \
  -H 'content-type: application/json' \
  -d "{
    \"site_slug\": \"demo-site\",
    \"batch_id\": \"$BATCH\",
    \"measurements\": [
      {\"emission_point\":\"stack-a\",\"recorded_at_ms\":$NOW_MS,\"value_kg_co2e\":\"123.456\"}
    ]
  }"

# Read metrics
curl http://localhost:3000/sites/demo-site/metrics
```

The web dashboard at `http://localhost:3001` lists sites with totals + compliance badges and exposes the same create + ingest paths through forms (with retry UX that reuses the same `batch_id`).

## Tests

```bash
pnpm typecheck             # tsc --noEmit across all 11 workspaces
pnpm lint                  # biome check .
pnpm format                # biome format --write . (writes fixes)
pnpm build                 # tsc -b / next build / tsup across the workspace
pnpm test                  # api integration + unit suites (Jest)
```

Per-workspace tests:

```bash
pnpm --filter @highwood/api test
pnpm --filter @highwood/alerting test
```

The api test suite **requires Postgres to be running** — `pnpm infra:up` first. The Jest global setup defaults `DATABASE_URL` to the local infra DSN (`postgresql://emissions:emissions@localhost:5432/emissions`) if not already set, runs migrations once per worker, and truncates tables between cases. A future hardening pass will swap this for Testcontainers per-suite isolation.

## Tear down

```bash
pnpm infra:down            # stop containers, keep volumes
pnpm infra:nuke            # stop + wipe volumes (fresh DB on next up)
```

## Layout

```
apps/
  api/             — NestJS HTTP API (POST /sites, POST /ingest, GET /sites, GET /sites/:slug/metrics, GET /docs)
  consumer/        — Kafka consumer; atomic measurements + outbox + metrics_outbox writer
  outbox-relay/    — Polls outbox, POSTs to alerting receiver
  system-alerts/   — Polls system_alerts table; parallel relay
  metrics-relay/   — Polls metrics_outbox; SETNX-guarded HINCRBYFLOAT against the Redis current-month cache
  alerting/        — HTTP sink with dedup; logs delivered events
  web/             — Next.js App Router dashboard
  etl/             — placeholder for nightly month-close + hourly stale-recompute
packages/
  config/          — Shared Zod env fragments (Postgres, Redis, Kafka, alerting client)
  contracts/       — Shared Zod schemas (single source of truth, consumed by api + web + relays)
  db/              — Drizzle schema + migrate runner; ships TS sources (no dist)
docs/
  PLAN.md          — Append-only planning record (every design exchange)
  SETUP.md         — This file (host-side `pnpm dev` workflow)
  DOCKER.md        — Everything-in-containers workflow (docker compose --profile apps)
  architecture/    — Deep-dive linked docs (idempotency, partitioning, cache-as-authority, outbox, metrics cache, …)
  c4/              — C4 model (PlantUML): context / containers / components / dynamic / deployment
ARCHITECTURE.md    — Design decisions, locking strategy, outbox + alerting flow, Redis metrics cache
```

## Troubleshooting

- **`docker compose: command not found`** — Compose v1 is unsupported; install Docker Desktop or the Compose v2 plugin.
- **`pnpm dev` exits with `ECONNREFUSED 5432`** — `pnpm infra:up` raced ahead of Postgres being ready; just rerun `pnpm dev` (the script waits via `infra:up` healthcheck, but cold-start can still beat it on slow disks).
- **Consumer logs `kafka.consumer.subscribed` but the metrics endpoint shows zeros after `POST /ingest`** — the consumer joined the group after the batch was produced; produce a second batch and the consumer will pick both up (existing in-flight messages are not replayed by default).
- **Test runner fails with `clearMocksOnScope is not a function`** — workspace has stale Jest packages from prior installs; `rm -rf node_modules && pnpm install` heals it.
