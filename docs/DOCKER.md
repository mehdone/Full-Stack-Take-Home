# Running with Docker Compose

← Back to [`ARCHITECTURE.md`](../ARCHITECTURE.md). For the host-side dev workflow (running apps via `pnpm dev` with infra in containers), see [`SETUP.md`](./SETUP.md).

This is the "everything in containers" path — useful for reviewers who want one command to bring the whole platform up, no Node/pnpm install required on the host.

## Prerequisites

- **Docker** with Compose v2 (`docker compose version` ≥ 2).

That's it. Node, pnpm, and all workspace dependencies live inside the images.

## Bring everything up

```bash
cp .env.example .env             # one-time; defaults work
docker compose --profile apps up -d --build
```

This brings up:

| Layer | Services |
|---|---|
| **Infra** (always-on, no profile) | `postgres` (5432), `redis` (6379), `kafka` (9092) |
| **Apps** (`--profile apps`) | `api` (3000), `web` (3001), `consumer`, `outbox-relay` (health 4101), `system-alerts` (health 4102), `metrics-relay` (health 4103), `alerting` (4100) |

Migrations run automatically as part of the API container's startup (see `apps/api/Dockerfile`).

Optional admin UIs (`--profile tools`): `pgadmin` on `:5050`, `kafka-ui` on `:8080`.

```bash
docker compose --profile apps --profile tools up -d --build
```

## Verify

```bash
# API health
curl http://localhost:3000/health

# Redoc UI for the API
open http://localhost:3000/docs

# Web dashboard
open http://localhost:3001
```

Smoke-test curls (create a site → ingest a batch → read metrics) live in [`SETUP.md`](./SETUP.md#smoke-check-the-api).

## Logs & status

```bash
docker compose ps                            # all services + health status
docker compose logs -f api consumer          # tail specific services
docker compose logs -f                       # tail everything
```

## Teardown

```bash
docker compose --profile apps --profile tools down     # stop + remove containers (keeps data)
docker compose down -v                                 # also wipe volumes (postgres/redis/kafka data)
```

The `pnpm infra:nuke` script is the equivalent shortcut for the volume-wipe.

## When to use this path vs. `pnpm dev`

| Use this (Docker Compose) when… | Use `pnpm dev` (host-side) when… |
|---|---|
| You're reviewing the project end-to-end | You're iterating on app code with hot-reload |
| You don't want Node/pnpm on the host | You want fast feedback (no rebuild step) |
| You want one command to reproduce the running stack | You want to attach a debugger to a single app |
| You're spinning up CI / a demo environment | You're touching schemas or contracts |
