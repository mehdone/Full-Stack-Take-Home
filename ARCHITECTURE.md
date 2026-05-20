# Highwood Emissions Data Platform — Architecture

> **TL;DR.** A NestJS + PostgreSQL ingestion platform for industrial methane readings. Three endpoints (`POST /sites`, `POST /ingest`, `GET /sites/:slug/metrics`) plus a Next.js dashboard. **Kafka decouples the `/ingest` hot path** from transactional work so field devices get a fast `202`; **Redis fronts `/ingest`** with edge dedupe and slug validation so Postgres is never touched on invalid or duplicate traffic; **a transactional outbox** guarantees the downstream alerting service can never miss an event. Concurrency is solved by partitioning Kafka by `site_slug` and using SQL `ON CONFLICT` primitives instead of row locks.

## API Reference

Live, interactive OpenAPI documentation is served by the API itself — start the stack (`pnpm dev`) and open:

| Resource | URL |
|---|---|
| **Redoc UI** (interactive reference) | <http://localhost:3000/docs> |
| **Raw OpenAPI 3.0 spec** (JSON) | <http://localhost:3000/openapi.json> |

The spec is generated from the same Zod schemas in `@highwood/contracts` that the backend validates against and the frontend consumes — request/response shapes here are guaranteed to match what the API enforces at runtime (§8.3).

## Table of Contents

1. [Overview](#1-overview)
2. [System Design Choices](#2-system-design-choices)
3. [The Hard Parts](#3-the-hard-parts)
4. [Request Lifecycles](#4-request-lifecycles)
5. [Data Model](#5-data-model)
6. [Idempotency in Depth](#6-idempotency-in-depth)
7. [Concurrency & Locking](#7-concurrency--locking)
8. [Platform Primitives](#8-platform-primitives)
9. [Cache-as-Authority Boundary](#9-cache-as-authority-boundary)
10. [Outbox & Alerting](#10-outbox--alerting)
11. [Frontend & Retry UX](#11-frontend--retry-ux)
12. [Build & Operate](#12-build--operate)
13. [Trade-offs, Deferrals & Non-Goals](#13-trade-offs-deferrals--non-goals)
- [Decision Register](#decision-register)
- [Appendix A — C4 Diagram Index](#appendix-a--c4-diagram-index)

---

## 1. Overview

### 1.1 Problem & non-negotiables

The system ingests methane readings from industrial sites. Four invariants are non-negotiable:

- **Atomic ingestion** — persisting raw measurements and updating per-site totals cannot diverge.
- **Idempotent retries** — field devices retry on timeout; a retry must not double-count.
- **Per-site concurrency** — 10 concurrent writers against one site is an explicit stress case.
- **Unified error/response contract** — established at `POST /sites`, applied platform-wide.

### 1.2 System context

(See `docs/c4/C1_context.puml`.)

| Actor | Touches | Purpose |
|---|---|---|
| Operations Admin | Web Dashboard | List sites, drill into metrics, manual ingest, retry |
| Field IoT Device | API | `POST /ingest` with stable `batch_id`, retries on timeout |
| Alerting Service (downstream) | Outbox Relay → HTTP | Receives business + operational events |

### 1.3 Container topology

(See `docs/c4/C2_containers.puml`.)

| Container | Tech | Owns |
|---|---|---|
| `apps/web` | Next.js 15 (App Router) | Dashboard, manual ingest form, retry UX |
| `apps/api` | NestJS 11 | Three HTTP endpoints, response envelope, Redis edge, Kafka produce |
| `apps/consumer` | NestJS standalone + kafkajs | Drains Kafka, runs the atomic ingest transaction |
| `apps/outbox-relay` | NestJS standalone | Polls `outbox`, POSTs to alerting receiver, backoff + escalation |
| `apps/metrics-relay` | NestJS standalone | Polls `metrics_outbox`, applies HINCRBYFLOAT to Redis via SETNX-guarded Lua |
| `apps/system-alerts` | NestJS standalone | Drains `system_alerts` (operational events) |
| `apps/alerting` | NestJS HTTP sink | Stub receiver; dedupes on `(event_type, batch_id)` |
| `apps/etl` | NestJS standalone | Monthly close + hourly stale recompute |
| `packages/db` | Drizzle + postgres-js | Schema, migrations, shared client |
| `packages/contracts` | Zod | Single source of truth for request/response shapes |

### 1.4 Capability inventory

| Capability | Status | § |
|---|---|---|
| Concurrency control | ✓ | §7 |
| Command/Processor (event-driven) | ✓ | §2.1 |
| Partitioning (monthly RANGE) | ✓ | §5 + [`partitioning.md`](docs/architecture/partitioning.md) |
| Transactional Outbox (alerting) | ✓ | §10 |
| Transactional Outbox (Redis metrics cache) | ✓ | §10.5 + [`metrics-cache.md`](docs/architecture/metrics-cache.md) |
| One-command DX | ✓ | §12.2 |
| Observability (dupe metrics) | ✓ | §8.2 |
| Type-safe contracts (Zod) | ✓ | §8.3 |
| API versioning | Deferred | §13.2 |

### 1.5 How to read this doc

- **30-second reviewer:** TL;DR + §1.4 + Decision Register.
- **Reviewer focused on the hard parts:** §3, then §6 + §7 + §10.
- **New contributor:** §1 → §2 → §4 → linked deep-dives as needed.
- **Operator:** §12, then `docs/SETUP.md`.

Linked docs under `docs/architecture/` exist for readers who want code-level depth on a specific subsystem. **This document stands on its own** — every load-bearing argument is here in full.

---

## 2. System Design Choices

This section names the three load-bearing system-shape decisions and what each one bought. Everything else in the document is a consequence of these three.

### 2.1 Kafka in the middle of ingest

**Decision.** `POST /ingest` does not write to Postgres directly. It validates the slug at the Redis edge, dedupes the `batch_id` at the Redis edge, and produces a single message to the `emissions.ingest.v1` Kafka topic keyed by `site_slug`. A separate `apps/consumer` drains the topic and runs the atomic transaction.

**What Kafka buys us:**

| Property | How Kafka delivers it                                                                                                                                                                                                                                                                                                                       |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Sub-50ms `/ingest` latency** | API path is `validate → SISMEMBER → HSETNX → produce → 202`. No DB round-trip on the hot path.                                                                                                                                                                                                                                              |
| **Per-site write serialization without locks** | Kafka guarantees one partition is consumed by exactly one consumer in the group at a time. Keying by `site_slug` routes all traffic for one site to one partition → one consumer instance. The "10 concurrent writers on one site" stress case becomes 10 messages back-to-back through one transaction loop — no row-level locking needed. |
| **Backpressure isolation** | Slow DB or consumer crash doesn't propagate to the API. Measurements buffer in Kafka.                                                                                                                                                                                                                                                       |
| **Replay & audit** | Topic is the durable log of accepted batches. Useful for debugging and for replay if the consumer-side schema evolves.                                                                                                                                                                                                                      |
| **Event-driven pattern** | Naturally produces a clean producer/processor split.                                                                                                                                                                                                                                                                         |

**What it costs:**

| Cost | Mitigation                                                                                                                                                                                  |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Eventual consistency on `GET /metrics` | Consumer drains within hundreds of ms in steady state. Metrics are not real-time, but near real-time, which is correct for compliance reporting (correctness > recency). See §2.3 and §5.3. |
| Extra operational surface (broker, consumer) | Single-broker KRaft in dev; replaceable with managed Kafka or Redpanda in prod. Consumer is a small NestJS standalone process.                                                              |
| Producer-side retry idempotency | Solved by `idempotent: true` KafkaJS producer (§6.2).                                                                                                                                       |

**Why not Postgres `LISTEN/NOTIFY`?** No replay after consumer crash, no per-key partition ordering, no scaling beyond one Postgres replica.

**Why not Redis Streams?** Persistence semantics weaker than Kafka; no equivalent of the idempotent-producer protocol; fewer per-partition consumer-group guarantees.

### 2.2 Redis at the `/ingest` edge

**Decision.** Redis sits in front of `POST /ingest` doing two distinct jobs:

1. **Slug validation** — `SISMEMBER sites:valid <slug>` decides whether the slug exists. A miss returns `404` with **no DB query**. (See §9.)
2. **Batch dedupe** — `HSETNX dedupe:<slug> <batch_id> 1` + `HEXPIRE 86400` (atomic, Lua) decides whether to publish this `batch_id` to Kafka. A duplicate returns `202` with `stale: true` and never reaches the consumer.

**What Redis buys us:**

| Concern                                    | Without Redis | With Redis |
|--------------------------------------------|---|---|
| Cost of an unknown slug                    | 1 DB round-trip (~1–5ms, holds a pool slot) | `SISMEMBER` O(1) (~µs) |
| Cost of a duplicate retry                  | Full Kafka produce + consumer round-trip + Postgres `ON CONFLICT DO NOTHING` | Lua round-trip; never reaches Kafka |
| `/ingest` DoS/DDoS surface (garbage slugs) | Pool exhaustion at ~10k req/s | Bounded by Redis throughput |

**Architecture-level effect.** The API can answer the vast majority of `/ingest` calls — valid duplicates, invalid slugs, normal first-sight publishes — **without touching Postgres**. Postgres is reserved for the consumer's transaction. This is what makes the API fast and the DB scalable in the same design.

**The coherence invariant that makes Redis trustable.** Site creation runs `INSERT INTO sites` and `SADD sites:valid <slug>` **inside the same Drizzle transaction**. If Redis is down, the site doesn't persist. Detail in §9.

### 2.3 Monthly aggregates instead of a live total

**Decision.** There is no `sites.total_emissions_to_date` column. Per-site totals are computed by **summing closed-month aggregates (cached) plus the current month (live)** at read time. A nightly ETL closes the prior month; a stale-flag mechanism handles late arrivals.

**What it buys:** No hot-row UPDATE on `sites` per ingest. Scales to 100M+ measurements. Decoupling: ingest never blocks on summary updates. Compliance-grade auditability: closed months are immutable historical summaries.

**What it costs:** `GET /sites/:slug/metrics` is eventually consistent — not atomic with ingest. Lag is bounded by consumer drain time (sub-second in normal operation). For OGMP 2.0 regulatory reporting this is correct; for live dashboards it is acceptable.

Detailed with a worked example in §5.3 — this is the section to read closely if you want to understand the read path.

### 2.4 Redis as the current-month live cache

**Decision.** `GET /sites/:slug/metrics` does not SUM the current month from `measurements` on every read. Instead, the consumer maintains a per-site Redis hash (`metrics:<site_id>`) with one field per site-local `(year, month)` and a `HINCRBYFLOAT` per accepted batch. The current-month component is an `HGET`.

**What Redis buys us on the read path:**

| Concern | Without the cache | With the cache |
|---|---|---|
| Current-month component cost | Partition scan of `measurements` for site × current month — grows monotonically through the month | `HGET` — O(1), constant regardless of how full the month is |
| `GET /metrics` peak latency | Worst case ≈ scan of ~10k–300k rows on day 30 of a busy site | Single Redis round-trip |
| Closed-month component | Cached in `site_monthly_emissions` (unchanged) | Cached in `site_monthly_emissions` (unchanged) |

**Postgres remains the source of truth.** Redis is a derived view. The bridge is a second transactional outbox (`metrics_outbox`, drained by `apps/metrics-relay`) written in the same consumer transaction as the measurements. If the consumer commits, the increment intent is durable; the relay applies HINCRBYFLOAT exactly-once via a SETNX-guarded Lua script.

**The same architectural pattern as the alerting outbox** (§10): durable intent in Postgres → background worker → external system. The only difference is the external system is Redis instead of HTTP.

Detailed in §10.5 with the divergence story, and in [`docs/architecture/metrics-cache.md`](docs/architecture/metrics-cache.md) for the deep dive (Lua script, precision analysis, operational drills).

---

## 3. The Hard Parts

> Each subsection summarizes one invariant; the deep dive follows in §5–§10.

### 3.1 Atomic ingest

The atomicity boundary is **the consumer's database transaction**, not the HTTP request.

```
BEGIN
  INSERT INTO measurements (...)
    ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING
    RETURNING ...

  -- Only for past site-local months. The current site-local month has no
  -- cache row and is read live from `measurements` by GET /metrics, so
  -- flagging it would be wasted write amplification.
  for each measurement where site_local_(year, month) < now_site_local_(year, month):
    INSERT INTO site_monthly_emissions (year, month, ...)
      ON CONFLICT (site_id, year, month) DO UPDATE SET stale = TRUE

  INSERT INTO outbox (event_type, payload, ...)
COMMIT

(then) commit the Kafka offset                          -- at-least-once
```

If the transaction commits, the outbox row exists and the relay will deliver it. If anything throws, nothing persists. Partial batches are impossible. The outbox row sits inside the same TX precisely so the alerting intent is as durable as the measurement data (§10).

### 3.2 Idempotent retries

**Three layers**, each narrowing the next's surface:

1. **Redis** — per-site HASH, field = `batch_id`, 24h TTL. Catches client-driven retries before Kafka.
2. **Kafka idempotent producer** — `idempotent: true` + `maxInFlightRequests: 1`. Catches producer-driven retries on broker/network blips inside `apps/api`.
3. **Postgres unique index** — `UNIQUE(batch_id, emission_point_id, recorded_at)` + `ON CONFLICT DO NOTHING`. Authoritative. Catches everything either of the above might miss.

**`batch_id` is the unit of idempotency.** Reusing it is the client's explicit "this is the same batch." To change the payload, issue a fresh `batch_id`. See §6.

### 3.3 Per-site concurrency

The 10-concurrent-writers stress case is solved by **system shape**, not by row locks:

- Kafka partitions by `site_slug` → all traffic for one site lands on one partition → consumed by exactly one consumer instance at a time → no two transactions for the same site run in parallel.
- For the rare cross-instance race during a Kafka partition rebalance, `INSERT … ON CONFLICT DO NOTHING` on the affected tables is sufficient.
- Deterministic sort ordering on new emission-point codes and on `(year, month)` upsert pairs prevents deadlocks if two transactions ever interleave.

**No `SELECT … FOR UPDATE` anywhere on the ingest path.** See §7.

### 3.4 Failure handling

| Failure | Detected by | Outcome |
|---|---|---|
| Client timeout + retry | Redis edge dedupe | `202 stale: true`, never re-published |
| API → Kafka network blip | KafkaJS idempotent producer | Broker drops the duplicate sequence |
| Consumer crash between DB commit and offset commit | Kafka redelivery + Postgres unique index | Re-run is a no-op insert; outbox row written with `measurements_inserted: 0`; receiver suppresses |
| Alerting receiver down | Outbox `available_at` + exponential backoff | Retried with jitter; `attempts ≥ max` → `system_alerts` exhaustion event |
| Clock-skew on a sensor | Pre-tx check vs site timezone | `4xx` + `system_alerts` row written |
| Unknown slug on `/ingest` | Redis `SISMEMBER` | `404` with no DB query |
| Redis down | Circuit breaker → single DB lookup | Ingest still works; degraded mode is paging-worthy |
| Consumer permanent abort (poison data) | `system_alerts` row | **Known limitation** — client sees only `202`; see §6.6 |

---

## 4. Request Lifecycles

### 4.1 `POST /sites` — establishes the envelope

(See `docs/c4/C3_api_components.puml`.)

```
request → RequestIdMiddleware → pino-http → ZodValidationPipe(CreateSiteSchema)
       → SitesController.create → SitesService.create
           BEGIN
             INSERT INTO sites RETURNING *
             SADD sites:valid <slug>          -- cache coherence (§9)
           COMMIT
       → ResponseInterceptor wraps { ok: true, data }
       → 201
```

If the `SADD` throws, the transaction rolls back and the site is not persisted. This guarantees Redis is authoritative for `/ingest` slug validation (§9).

### 4.2 `POST /ingest` — the hot path

(See `docs/c4/dynamic_ingest.puml`.)

```
request → middleware/validation
       → SISMEMBER sites:valid <slug>            ─ miss? 404, no DB
       → HSETNX dedupe:<slug> <batch_id>  (Lua)  ─ duplicate? 202 stale:true
       → produce ingest.batches keyed by slug
       → 202 { batch_id, status: "queued", stale: false }

(asynchronously)
consumer ← Kafka
       → resolve emission-point ids (process cache → SELECT → INSERT ON CONFLICT → re-SELECT)
       → BEGIN
           INSERT measurements ON CONFLICT DO NOTHING
           UPSERT site_monthly_emissions stale=TRUE for past site-local months
           INSERT outbox                          -- alerting (one row per batch)
           INSERT metrics_outbox                  -- Redis sum cache (one row per (site, year, month))
         COMMIT
       → commit Kafka offset
```

Full sequence with all edge cases → [`docs/architecture/ingest-pipeline.md`](docs/architecture/ingest-pipeline.md).

### 4.3 `GET /sites/:slug/metrics` — eventually consistent

```
total = SUM(site_monthly_emissions.total_kg
            WHERE year/month < current_site_local_month AND stale = FALSE)   -- Postgres (closed months)
      + COALESCE(HGET metrics:<site_id> <current_yyyymm>, 0)                 -- Redis  (current month)
```

The current-month component is an O(1) `HGET` against a per-site Redis hash kept coherent by the `metrics_outbox` + `apps/metrics-relay` pair (§2.4, §10.5). Postgres remains the source of truth; Redis is a derived view.

**Fallback.** If Redis is unavailable at read time, fall back to the live SUM:

```
total = SUM(site_monthly_emissions … past months)
      + SUM(measurements.value WHERE site_id = ? AND recorded_at >= start_of_current_site_local_month)
```

Same circuit-breaker shape as `/ingest`'s cache-as-authority boundary (§9): correctness preserved, latency degraded during a Redis outage.

If any aggregated past month is `stale = TRUE`, it is recomputed on demand and the response includes a `stale_aggregates_recomputed` hint. Worked example in §5.3.

### 4.4 The platform pipeline

Every request goes through the same five-stage chain (middleware → logging → validation → controller → interceptor; filter as alternate exit), so the envelope guarantee is structural, not aspirational. Pipeline diagram + the `APP_FILTER`-as-provider rationale → [`docs/architecture/response-envelope.md`](docs/architecture/response-envelope.md).

---

## 5. Data Model

### 5.1 Reference tables (terse)

| Table | Purpose | Key | Notable invariant |
|---|---|---|---|
| `sites` | One row per industrial facility | `id`; `slug` UNIQUE | `slug` is the external identity; immutable after create |
| `site_emission_points` | Sub-sources within a site (vents, flares, etc.) | `id`; `UNIQUE(site_id, code)` | Append-only; auto-created on first sight via `ON CONFLICT DO NOTHING` |
| `measurements` | Raw readings (RANGE-partitioned monthly) | `(id, recorded_at)` PK; `UNIQUE(batch_id, emission_point_id, recorded_at)` | Partition key must appear in any unique constraint. See [`partitioning.md`](docs/architecture/partitioning.md). |
| `outbox` | One row per ingest batch (alerting) | `id` | Written in the same TX as measurements. See §10. |
| `metrics_outbox` | One row per (site, year, month) touched by an ingest batch (Redis cache) | `id` | Written in the same TX as measurements. See §10.5 + [`metrics-cache.md`](docs/architecture/metrics-cache.md). |
| `system_alerts` | Operational events (clock skew, unknown slug, etc.) | `id` | Sibling shape to `outbox`; relayed by separate worker. |

These are conventional tables; full column lists live in `packages/db/src/schema/`. What matters architecturally is the next table.

### 5.2 `site_monthly_emissions` — the ETL aggregateded emissions

This table is **the centerpiece of the read path**. It replaces the conventional `sites.total_emissions_to_date` column.

```
site_monthly_emissions
├─ site_id      bigint        FK
├─ year         smallint
├─ month        smallint      1..12
├─ total_kg     numeric(18,6)
├─ stale        boolean       TRUE = needs recompute (a late measurement reading landed in this month)
└─ computed_at  timestamptz

PRIMARY KEY (site_id, year, month)
```

Each row is the precomputed sum of `measurements.value` for that `(site, year, month)`. Rows are **only updated by ETL or recompute jobs**, never on the ingest path — the ingest path only writes `stale = TRUE` to flag "this month changed; recompute later."

### 5.3 How metrics are computed — the ETL & stale-flag story

Three actors interact with `site_monthly_emissions`. Understanding all three is how this design clicks.

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  (1) Ingest consumer — runs on every accepted batch                  │
│      All (year, month) values are in the SITE'S LOCAL CALENDAR       │
│      (sites.timezone, IANA).                                         │
│                                                                      │
│      After inserting measurements, for each distinct site-local      │
│      (year, month) that is STRICTLY BEFORE the site's current        │
│      local (year, month):                                            │
│        INSERT INTO site_monthly_emissions                            │
│          (site_id, year, month, total_kg, stale)                     │
│          VALUES (?, ?, ?, 0, FALSE)                                  │
│        ON CONFLICT (site_id, year, month)                            │
│          DO UPDATE SET stale = TRUE                                  │
│                                                                      │
│      → "I touched this PAST month. Someone needs to recompute it."   │
│      → Current-month measurements skip the UPSERT entirely:          │
│        no cache row exists yet, and GET /metrics reads the current   │
│        month live from `measurements`. Avoiding the write removes    │
│        per-batch WAL exhaustion on the steady-state hot path.        │
│                                                                      │
│  (2) Nightly month-close ETL — day 2 of M+1 at 02:00 UTC             │
│      For each site:                                                  │
│        total = SUM(measurements.value WHERE recorded_at IN month M)  │
│        UPSERT site_monthly_emissions                                 │
│          SET total_kg = total,                                       │
│              stale = FALSE,                                          │
│              computed_at = now()                                     │
│                                                                      │
│      → "Month M is now closed. Late arrivals will flip stale=TRUE."  │
│      → Runs day 2 (not day 1) to absorb late-arriving readings       │
│        from the last hours of month M.                               │
│                                                                      │
│  (3) Hourly stale-recompute job                                      │
│      SELECT * FROM site_monthly_emissions WHERE stale = TRUE         │
│      For each row: re-sum that (site, year, month) and clear stale.  │
│                                                                      │
│      → "Catch up the months that ingest flagged."                    │
│      → Bounds worst-case read staleness to ~1 hour.                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

A **fourth actor** keeps the current-month live cache (Redis) coherent (§2.4, §10.5):

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  (4) Ingest consumer + apps/metrics-relay                            │
│                                                                      │
│      Consumer, inside the ingest TX, for every distinct site-local   │
│      (year, month) in the batch's inserted measurements:             │
│        INSERT INTO metrics_outbox (site_id, year, month, delta_kg)   │
│          VALUES (?, ?, ?, sum-of-values-for-that-month)              │
│                                                                      │
│      Metrics-relay tick (FOR UPDATE SKIP LOCKED):                    │
│        For each pending row → EVAL Lua:                              │
│          SETNX applied:metrics_outbox:<id>                           │
│          if first sight:                                             │
│            HINCRBYFLOAT metrics:<site_id> <yyyymm> <delta_kg>        │
│            HEXPIRE     metrics:<site_id> <90d> FIELDS 1 <yyyymm>     │
│        UPDATE metrics_outbox SET delivered_at = now()                │
│                                                                      │
│      → "The hash field metrics:<site_id>/<current_yyyymm> is what    │
│         GET /metrics reads for the current-month component."         │
│      → The SETNX guard makes HINCRBYFLOAT exactly-once under         │
│         at-least-once relay delivery.                                │
│      → Past-month rows land in past-month fields harmlessly;         │
│         the read path only consults the current month.               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

#### Worked example

A site has emissions in Jan, Feb, Mar 2026. Today is **Apr 15, 2026**.

| Month | Row in `site_monthly_emissions` | How `total` is computed |
|---|---|---|
| Jan | `total_kg = 1240.5, stale = FALSE` | Use cached value → **1240.5** |
| Feb | `total_kg = 1102.8, stale = FALSE` | Use cached value → **1102.8** |
| Mar | `total_kg = 980.3, stale = TRUE` (a late reading arrived yesterday and the hourly job hasn't run yet) | Recompute on demand: `SUM(measurements WHERE month = Mar)` = **994.7**; UPDATE row to clear stale |
| Apr | (no row yet — current month) | Live: `SUM(measurements WHERE month = Apr)` = **312.9** |

`GET /sites/highwood-1/metrics` returns `total_emissions_kg = 3651.0`. The next request sees March already cleared and skips the recompute.

#### Why this design earns its eventual-consistency cost

- **Scalability.** Ingest never touches the `sites` row. 10k concurrent writers never serialize on a hot row, because there is no hot row.
- **Auditability.** Closed-month rows are immutable summaries; perfect for OGMP 2.0 regulatory reporting (auditors get a row, not a recomputation).
- **Cheap reads.** A 5-year-old site's total is `~60 row lookups + 1 live SUM`, not a scan of millions of measurements.
- **Late-arrival correctness.** `stale = TRUE` makes late readings observable and recoverable; nothing is silently dropped or double-counted.

#### Why the bounds are correct

- Closed months never lose data: the recompute always re-reads from `measurements`, which is append-only and partition-bounded.
- Late arrivals into closed months are flagged within one ingest transaction (atomic with the measurement INSERT).
- Worst-case read staleness is bounded by the hourly job interval, with the on-demand recompute closing the gap for the request that hits a stale row.

#### Partitioning details

Partition rules, the unique-constraint-must-include-partition-key consequence, monthly rollover script, DEFAULT-partition reclaim → [`docs/architecture/partitioning.md`](docs/architecture/partitioning.md).

---

## 6. Idempotency in Depth

The unit of idempotency is `batch_id`. Three layers defend, each narrowing the next's surface; the bottom layer is authoritative.

### 6.1 Layer 1 — Redis edge HASH (per-site)

```
HSETNX dedupe:<site_slug> <batch_id> 1
HEXPIRE dedupe:<site_slug> 86400 FIELDS 1 <batch_id>
```

Atomic via Lua. First sight returns `1` → proceed to produce; duplicate returns `0` → `202 stale: true`, no Kafka message. 24h TTL via `HEXPIRE` is the practical retry window; tunable via `BATCH_DEDUPE_TTL_SECONDS`. Per-site HASH (not per-batch top-level key) keeps memory bounded.

If Redis loses the entry (TTL expiry, manual `HDEL`, restart), the next layer catches it.

### 6.2 Layer 2 — Kafka idempotent producer

```ts
this.producer = this.kafka.producer({
  idempotent: true,
  maxInFlightRequests: 1,   // required by the idempotent protocol
  retry: { retries: 5 },
});
```

Every produce request is stamped with a producer ID + per-partition sequence number. The broker drops out-of-order or duplicate sequences. This catches **producer-driven** retries (the same produce call retried inside `apps/api` after a transient broker/network error) that Redis would not see.

`maxInFlightRequests: 1` is mandatory: allowing >1 would let acks return out of order, and a retry could reorder messages on the log. KafkaJS enforces this when `idempotent: true`.

### 6.3 Layer 3 — Postgres unique index (authoritative)

```sql
UNIQUE (batch_id, emission_point_id, recorded_at)

INSERT INTO measurements (...) VALUES (...)
  ON CONFLICT DO NOTHING
  RETURNING *;
```

The partition key (`recorded_at`) must be in any unique constraint on a partitioned table — Postgres rule. Microsecond precision makes same-point-same-instant collisions implausible for physical sensors. The `RETURNING` count is what feeds the outbox payload — duplicates contribute zero.

### 6.4 Unit of idempotency = `batch_id`

A retry with the same `batch_id` but a **different** measurements array has its second payload silently dropped: the Redis HSETNX returns 0; if Redis missed it, the unique index rejects the new rows because they collide with the same `batch_id`. **To change the payload, issue a fresh `batch_id`.** This is the client contract.

### 6.5 Outbox multiplicity & receiver-side dedupe

The outbox can carry **multiple rows per `batch_id`** by design:

| Cause | Outbox row contents |
|---|---|
| Redis-bypassed retry (TTL expiry, FLUSHDB, restart) | `measurements_inserted: 0` |
| Consumer crash between DB commit and Kafka offset commit | `measurements_inserted: 0` |
| Blue/green deploy briefly running two consumer replicas | Second row with `measurements_inserted: 0` |

The relay and `apps/alerting` are contracted to:
- Dedupe on `(event_type, aggregate_id, payload.batch_id)` via in-memory bounded LRU (10k entries).
- Suppress the notification when `payload.measurements_inserted == 0`.

### 6.6 Known limitation — consumer-permanent-failure lockout

If a batch is accepted (`202` returned, `batch_id` stored in Redis) but the consumer transaction permanently aborts (poison data, FK violation, numeric overflow), the client retrying with the same `batch_id` gets `stale: true` and never learns the original attempt failed. A `system_alerts` row surfaces the failure to ops, but the client sees only silence.

Mitigations identified, none implemented:
1. Admin endpoint `DELETE /admin/ingest/dedupe/:slug/:batch_id` to clear a stuck entry.
2. Shorter default TTL (1h instead of 24h).
3. Consumer signal-back via a `batch_failed:<batch_id>` Redis set that the API checks before returning `202`.

---

## 7. Concurrency & Locking

### 7.1 Why Kafka partitioning by `site_slug` is load-bearing

Kafka guarantees: a partition is consumed by **exactly one** consumer instance at a time within a consumer group. Keying by `site_slug` routes all traffic for one site to one partition → one consumer. The "10 concurrent writers against one site" scenario becomes 10 messages processed back-to-back by one transaction loop. There is no concurrent write to the same site at the database layer — the serialization happens at the queue.

### 7.2 No `FOR UPDATE`

`SELECT … FOR UPDATE` is not used anywhere on the ingest path. With the `sites.total_emissions_to_date` column gone (§2.3, §5.3), there is nothing to serialize at the row level. Remaining contention surfaces are each handled by an SQL primitive:

| Surface | Handled by |
|---|---|
| First-time emission-point creation under partition rebalance | `INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING` + re-SELECT |
| Measurement dedupe | `INSERT … ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING` |
| Monthly-aggregate stale flag | `INSERT … ON CONFLICT (site_id, year, month) DO UPDATE SET stale = TRUE` |

All three primitives are atomic at `READ COMMITTED` (Postgres default) without explicit locks.

### 7.3 Deterministic lock ordering

Inside a transaction, the consumer sorts:
- New emission-point codes (lexicographic) before the `INSERT ON CONFLICT` batch.
- Distinct `(year, month)` pairs (chronological) before the stale-flag upserts.

This ensures two concurrent transactions (the rare partition-rebalance race) acquire tuple locks in the same order, eliminating any deadlock risk.

### 7.4 Walking through "10 concurrent writers"

```
10 clients POST /ingest with same site_slug
  → 10 API instances all SISMEMBER OK, HSETNX OK (different batch_ids)
  → 10 produces to Kafka, all keyed by the same site_slug
  → 1 partition receives all 10 messages in order
  → 1 consumer processes them sequentially
  → 10 transactions run serially against Postgres, no contention
```

The system-level concurrency is real (10 simultaneous HTTP requests). It is absorbed at the API and serialized at Kafka before it ever reaches Postgres.

---

## 8. Platform Primitives

### 8.1 Response envelope

Every API response:

```jsonc
// 2xx
{ "ok": true, "data": { /* ... */ } }

// 4xx/5xx
{ "ok": false, "error": { "code": "...", "message": "...", "details": {/* ... */}, "request_id": "..." } }
```

| Code | HTTP | Cause |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Zod failure, clock skew, bad timezone |
| `NOT_FOUND` | 404 | Site not found |
| `CONFLICT` | 409 | Slug already exists; FK / unique violation (`23505`) |
| `RATE_LIMITED` | 429 | Reserved |
| `INTERNAL` | 500 | Unhandled exception (full stack logged; message sanitized) |

Wired as `APP_FILTER` / `APP_INTERCEPTOR` **providers in `AppModule`**, not via `useGlobalFilters` in `main.ts`. Critical so the envelope guarantee survives the test bootstrap. Pipeline diagram + the wiring rationale → [`docs/architecture/response-envelope.md`](docs/architecture/response-envelope.md).

### 8.2 Request-id & logging

UUID v7 (preferred) attached by `RequestIdMiddleware`; echoed on responses; bound to every pino log line via `nestjs-pino`. Duplicate-rejection counts logged as structured `inserted` / `duplicates` fields on every consumer batch.

### 8.3 Shared Zod contracts

`packages/contracts` exports `CreateSiteSchema`, `IngestBatchSchema`, `SiteMetricsResponseSchema`, the envelope schemas, and shared building blocks (`SiteSlugSchema`, `BatchIdSchema`, `TimezoneSchema`, etc.). Same schemas drive the NestJS validation pipe, the consumer's payload validation, and the Next.js form resolvers — one source of truth, no client/server drift.

### 8.4 Config & CORS

Env validated by Zod at bootstrap; missing or malformed `DATABASE_URL` fails fast with a clear message. Dev: permissive CORS. Prod: deny-by-default; explicit `CORS_ALLOWED_ORIGINS` allowlist (fail-secure).

---

## 9. Cache-as-Authority Boundary

> The Redis `sites:valid` SET is the sole source of truth for slug validation on `POST /ingest`. A cache miss returns `404` **without ever touching the database**. This is a deliberate DOS-hardening boundary, not an optimization, and it is load-bearing.

### 9.1 The threat

`POST /ingest` is public and high-throughput. If a cache miss fell through to `SELECT FROM sites WHERE slug = ?`, an attacker spraying random slugs at ~10k req/s would consume roughly 30 connection-seconds per second of DB pool — saturating it within seconds and queueing legitimate ingests behind attacker traffic. Cheap-request / expensive-response amplification.

| Lookup | Cost |
|---|---|
| Redis `SISMEMBER` | O(1), microseconds, no pool acquisition |
| Postgres `SELECT … WHERE slug = ?` | O(log n) + pool acquisition + network + planning ≈ 1–5ms, holds a pool slot |

### 9.2 The boundary

| Outcome | Behavior | DB touched? |
|---|---|---|
| `SISMEMBER` returns 0 | `404` immediately | No |
| `SISMEMBER` throws (Redis down) | Single DB `SELECT` as circuit breaker | Yes, only in degraded mode |
| `SISMEMBER` returns 1 | Proceed to dedupe + produce | No (not at this stage) |

The circuit-breaker path **does not** attempt a `SADD` re-warm. Redis is by assumption unhealthy; a SADD would likely fail too, doubling the round-trip cost during a degraded mode. Re-warm is the job of `BootstrapService.warmSitesCache()` and the transactional `SitesService.create()` path, not the request handler.

### 9.3 The coherence invariant

Two coordinated guarantees keep the cache trustworthy:

1. **Boot-time warm.** `BootstrapService.warmSitesCache()` runs after every module init: `SELECT slug FROM sites` → `SADD sites:valid …`. The cache is rebuilt before traffic is accepted.
2. **Transactional write coherence.** `SitesService.create()` runs the INSERT and the SADD **inside one Drizzle transaction**. If the SADD throws, the row never persists.

The asymmetry — **site creation requires both DB and Redis healthy; measurement ingest requires only Redis healthy** — is intentional. Creation is rare and operator-initiated; ingest is the hot path. Different availability budgets are appropriate.

Alternatives considered and rejected (cache-only with 503, polling re-warm, treating SADD failure as non-fatal) → [`docs/architecture/cache-as-authority.md`](docs/architecture/cache-as-authority.md).

---

## 10. Outbox & Alerting

### 10.1 Why outbox over direct emit

If the consumer did `BEGIN; INSERT measurements; COMMIT; POST /alerts` and crashed between the COMMIT and the POST, the alert would be lost — the data persisted but the notification didn't. Putting the alert intent (the outbox row) into the **same transaction** as the measurements makes the alert as durable as the data itself.

```
BEGIN
  INSERT measurements
  INSERT outbox        ← same TX; if commit succeeds, the relay will deliver
COMMIT
```

(See `docs/c4/C3_outbox_relay_components.puml`.)

### 10.2 Relay polling pattern

```sql
BEGIN
  SELECT ... FROM outbox
  WHERE delivered_at IS NULL AND available_at <= now()
  FOR UPDATE SKIP LOCKED
  LIMIT OUTBOX_BATCH_SIZE

  -- For each row:
  --   POST /alerts/business with X-Idempotency-Key = outbox_id
  --   2xx → UPDATE delivered_at = now()
  --   error → attempts++, last_error=..., available_at = now() + backoff
  --   attempts >= MAX → INSERT system_alerts (exhaustion), freeze the row
COMMIT
```

`FOR UPDATE SKIP LOCKED` lets multiple relay replicas process disjoint subsets of pending rows without coordination — important for blue/green deploys and horizontal scaling. A partial index `(available_at) WHERE delivered_at IS NULL` keeps the scan cheap regardless of historical row count.

Backoff formula: `min(2^attempts * baseSeconds, capSeconds) + jitter`. Math, exhaustion semantics, manual recovery → [`docs/architecture/outbox-relay.md`](docs/architecture/outbox-relay.md).

### 10.3 `system_alerts` — sibling pattern, no recursion

A second relay (`apps/system-alerts`) drains the `system_alerts` table the same way, with one critical difference: **on exhaustion it logs and freezes the row rather than writing another `system_alerts` row** — otherwise an outage would recurse infinitely.

### 10.4 Receiver-side dedupe

`apps/alerting` dedupes on `(event_type, aggregate_id, payload.batch_id)` via in-memory bounded LRU (10k entries), and suppresses notifications when `payload.measurements_inserted == 0`. Logs `alert.delivered` / `alert.duplicate_suppressed` structured events. No persistence — pure sink.

### 10.5 `metrics_outbox` — sibling outbox for the Redis cache

The same outbox shape is reused for a second job: keeping the Redis pre-aggregated current-month sum (§2.4) coherent with Postgres.

**Why a sibling, not a shared table:** the existing `outbox` is drained by `apps/outbox-relay`, which POSTs HTTP to the alerting receiver. A "Redis increment" is a different kind of work (HINCRBYFLOAT, not HTTP). Mixing them in one table would require event-type discrimination on every poll query and would couple two unrelated relays' progress. Sibling tables match the existing `outbox` / `system_alerts` split: one table per relay responsibility.

**Schema** (`metrics_outbox`):

```
id, site_id, year, month, delta_kg (numeric(18,6)),
created_at, available_at, attempts, last_error, delivered_at
+ partial index (available_at) WHERE delivered_at IS NULL
+ FK site_id → sites(id) ON DELETE CASCADE
```

One row per distinct site-local `(year, month)` in an ingest batch's actually-inserted measurements; `delta_kg` is the sum of `value` for those measurements. Written in the same TX as the measurements + the alerting outbox row.

**Relay** (`apps/metrics-relay`): identical polling pattern to outbox-relay (`FOR UPDATE SKIP LOCKED`, exponential backoff, exhaustion → `system_alerts` + freeze). The difference is the work it does per row:

```lua
-- Atomic, via EVAL. Guarantees exactly-once HINCRBYFLOAT under
-- at-least-once relay delivery.
local applied = redis.call("SETNX", "applied:metrics_outbox:<id>", "1")
if applied == 1 then
  redis.call("EXPIRE", "applied:metrics_outbox:<id>", <applied_ttl>)
  redis.call("HINCRBYFLOAT", "metrics:<site_id>", "<yyyymm>", "<delta_kg>")
  redis.call("HEXPIRE",      "metrics:<site_id>", <field_ttl>, "FIELDS", 1, "<yyyymm>")
end
```

The SETNX guard is required because `HINCRBYFLOAT` is not idempotent. The relay's `SELECT FOR UPDATE SKIP LOCKED → do work → UPDATE delivered_at` prevents concurrent races on the same row but does not cover the crash between the Redis call and the SQL `UPDATE`. On restart, the relay would re-process the row; without the guard, the HINCRBYFLOAT would double-count → permanent drift.

Full deep-dive (Lua mechanics, precision analysis, divergence story, operational drills, future scaled-integer migration path) → [`docs/architecture/metrics-cache.md`](docs/architecture/metrics-cache.md).

---

## 11. Frontend & Retry UX

(See `docs/c4/C3_web_components.puml`.)

The dashboard does three things:

| Page | Behavior |
|---|---|
| `/` (Sites list) | Server-rendered table; per-row client component fetches `/sites/:slug/metrics` and shows a compliance pill |
| `/sites/new` | `CreateSiteForm` validates with the shared `CreateSiteSchema` and POSTs |
| `/ingest` | `IngestForm` generates a stable `batch_id` (UUID v4) **once on mount** and reuses it on every retry — this is the front of the idempotency contract (§6.4) |

The retry UX is intentionally simple: the form remembers the `batch_id` across submission attempts. A 5xx or network error displays a "Retry" button that resubmits the same payload with the same `batch_id`. The backend's three idempotency layers ensure no double-count regardless of how many times the user clicks.

Schemas come from `@highwood/contracts` via `zodResolver`. No client-side schema drift.

---

## 12. Build & Operate

### 12.1 Workspace layout

```
apps/
  api/             HTTP API (NestJS)
  consumer/        Kafka consumer + transactional ingest
  outbox-relay/    Drains outbox → alerting receiver
  metrics-relay/   Drains metrics_outbox → Redis HINCRBYFLOAT (current-month cache)
  system-alerts/   Drains system_alerts → alerting receiver
  alerting/        HTTP sink (stub for downstream alerting)
  etl/             Monthly close + hourly stale recompute
  web/             Next.js dashboard
packages/
  db/              Drizzle schema, migrations, client
  contracts/       Shared Zod schemas
  config/          Shared env validation
docs/
  c4/              C4 diagrams (PlantUML)
  architecture/    Deep-dive linked docs (this file links into them)
  SETUP.md         Runnable bits
  PLAN.md          Planning conversations (decision log)
```

### 12.2 Local one-command bootstrap

```bash
cp .env.example .env
pnpm install
pnpm dev          # docker compose up -d + tsx watch all apps
```

Migrations run automatically on boot. Seed data optional. Full operator instructions in `docs/SETUP.md`.

### 12.3 Production bundling

Each app uses `tsup` with `noExternal: ["@highwood/contracts", "@highwood/db", "@highwood/config"]` to inline shared TS-source packages into a single `dist/main.js`. NestJS decorator metadata requires `@swc/core`. Details → [`docs/architecture/production-bundling.md`](docs/architecture/production-bundling.md).

### 12.4 Migrations & partitioning maintenance

Drizzle Kit generates SQL diffs; hand-written migrations cover what Drizzle doesn't model (partitioning, triggers). The monthly partition rollover script (creates next month's partition before its boundary is crossed) lives in `apps/etl`. DEFAULT-partition reclaim procedure documented in [`docs/architecture/partitioning.md`](docs/architecture/partitioning.md).

---

## 13. Trade-offs, Deferrals & Non-Goals

### 13.1 Deliberate omissions

| Choice | Why |
|---|---|
| No live `sites.total_emissions_to_date` column | Hot-row UPDATE doesn't scale to 100M+ rows. Monthly aggregates + eventual consistency is the documented trade-off (§2.3, §5.3). |
| No Redis read-cache beyond the dedupe HASH and `sites:valid` SET | Postgres is fast enough; profiling never showed hot reads. |
| No pessimistic locking (`FOR UPDATE`) on ingest | Remaining contention is correctly handled by SQL `ON CONFLICT` primitives. Locks would add latency without improving correctness. |
| No PostGIS | Numeric lat/lon with 6 decimals (~11 cm precision) is sufficient for site metadata. |
| No multi-topic Kafka pipeline | Single topic + keyed partitioning + one consumer group is simpler and gets the same event-driven properties. |

### 13.2 Deferred

| Item | Status |
|---|---|
| API versioning | Low ROI; would be `/v1/` prefix + `Accept-Version` header. |
| Consumer-permanent-failure lockout mitigations | Three options identified (§6.6); none implemented. |
| Rate limiting per IP / per site | Error code reserved; implementation deferred. |
| Soft deletes & audit-log of who ingested | Out of scope for the current system. |
| Live deployment URL | Submission-time decision. |

### 13.3 Open questions

No blockers identified. Operational hardening (managed Kafka, managed Redis with HA, partition-rollover automation, true Testcontainers isolation in CI) is the obvious next step beyond the current scope.

---

## Decision Register

| # | Decision | Choice | Alternative considered | Why this won | § |
|---|---|---|---|---|---|
| D1 | Async ingest path | Kafka topic between API and consumer | Synchronous API → Postgres | Fast 202 + partition-by-slug gives per-site serialization without locks | §2.1 |
| D2 | Edge slug validation | Redis `sites:valid` SET, cache-as-authority | DB on every request | DOS hardening; bounds attacker cost to Redis | §2.2, §9 |
| D3 | Edge batch dedupe | Redis HASH + HEXPIRE per site | Per-key dedupe or DB-only | O(1), memory-bounded, atomic via Lua | §6.1 |
| D4 | Producer dedupe | KafkaJS `idempotent: true` | Application-level retry tracking | Broker-enforced exactly-once per producer-partition | §6.2 |
| D5 | Authoritative dedupe | Postgres unique index + `ON CONFLICT` | Application-level upserts | Cannot be bypassed; survives Redis/Kafka outages | §6.3 |
| D6 | Per-site write serialization | Kafka partitioning by `site_slug` | `SELECT … FOR UPDATE` on the site row | Serialization at queue, not row; eliminates hot-row contention | §2.1, §7.1 |
| D7 | Per-site total | `site_monthly_emissions` aggregate + ETL | Live `total_emissions_to_date` column | Scales to 100M+ rows; auditability; no hot-row UPDATE | §2.3, §5.3 |
| D8 | Measurements layout | RANGE partition by `recorded_at` monthly | Single table / hash partitioning | Time-based queries are the dominant workload; partition pruning is huge | §5, partitioning.md |
| D9 | Downstream alerting | Transactional outbox + relay | Direct POST from consumer | Survives consumer crash; same durability as the data | §10 |
| D10 | Lock primitive | SQL `ON CONFLICT` + deterministic sort | `FOR UPDATE` | Lower latency; sufficient given Kafka serializes per-site already | §7.2, §7.3 |
| D11 | Envelope wiring | `APP_FILTER` / `APP_INTERCEPTOR` providers | `useGlobalFilters` in `main.ts` | Applies in the test bootstrap too; can't be silently skipped | §8.1, response-envelope.md |
| D12 | Schema source of truth | Shared Zod in `@highwood/contracts` | Hand-written DTOs on both sides | One source for backend + frontend + runtime validation | §8.3 |
| D13 | Current-month sum on `/metrics` | Per-site Redis hash + HINCRBYFLOAT, kept coherent by `metrics_outbox` + sibling relay | Live `SUM(measurements)` per request | O(1) read regardless of month volume; same durability shape as the alerting outbox | §2.4, §10.5, metrics-cache.md |
| D14 | Exactly-once HINCRBYFLOAT | SETNX-guarded Lua per outbox-row id | Best-effort + reconciliation job | Eliminates drift on relay-restart between Redis call and SQL `UPDATE delivered_at` | §10.5, metrics-cache.md |

For the deeper "why" behind each, see `docs/PLAN.md`.

---

## Appendix A — C4 Diagram Index

All under `docs/c4/`. Render with any PlantUML toolchain.

| File | Level | Subject |
|---|---|---|
| `C1_context.puml` | Context | Whole system + external actors |
| `C2_containers.puml` | Container | All deployable units |
| `C3_api_components.puml` | Component | Inside `apps/api` |
| `C3_consumer_components.puml` | Component | Inside `apps/consumer` |
| `C3_outbox_relay_components.puml` | Component | Inside `apps/outbox-relay` |
| `C3_system_alerts_components.puml` | Component | Inside `apps/system-alerts` |
| `C3_alerting_components.puml` | Component | Inside `apps/alerting` |
| `C3_web_components.puml` | Component | Inside `apps/web` |
| `dynamic_ingest.puml` | Dynamic | Runtime sequence of a `/ingest` request |
| `deployment.puml` | Deployment | docker-compose topology |

---

**Document version.** Initial structure, 2026-05-20.
