# Architecture — Highwood Emissions Ingestion Platform

## 1. Overview

Highwood is a distributed emissions ingestion and analytics platform designed to handle high-volume, concurrent measurement streams from industrial sensors while guaranteeing data integrity under network failures and retry storms. The system provides three core backend services: site management (`POST /sites`), reliable batch ingestion (`POST /ingest`, up to 100 readings per batch), and compliance reporting (`GET /sites/:id/metrics`). A frontend dashboard allows operators to monitor sites and manually ingest test batches. The architecture is built to prevent double-counting under simultaneous writes, survive producer timeouts with automatic retries, and scale to 100M+ historical measurements without live-column hot-spots.

---

## 2. Stack & Layout

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **API** | NestJS + Express | Mature decorator-driven DI; request-id propagation via structured logging (pino) baked in |
| **Async Pipeline** | Kafka (KRaft, single broker) | Decouples ingest response time from downstream work; keyed by `site_id` preserves per-site ordering for locking |
| **Consumer** | NestJS Kafka microservice | Command/Processor pattern (bonus #2); same DI and observability story as the API |
| **Cache Layer** | Redis 7.4 | HEXPIRE for per-site batch deduplication with automatic TTL (24h default, tunable) |
| **Database** | PostgreSQL 16 + Drizzle ORM | RANGE-partitioned `measurements` table by month; composite PKs and unique indexes required by partition rule |
| **Web** | Next.js App Router + TanStack Query | Deferred to Phase 7; frontend and backend dedupe collaborate via shared `batch_id` on retry |

**Workspace layout:**
- `apps/api` — HTTP API, NestJS + Express, enveloped responses, request-id middleware
- `apps/consumer` — Kafka ingest consumer (Phase 4, transactional writes with locking decision TBD)
- `apps/alerting` — Outbox relay receiver, HTTP stub (Phase 5)
- `apps/etl` — Monthly aggregates closer + stale-flag hourly recompute (Phase 5)
- `apps/system-alerts` — System alert relay receiver (Phase 5)
- `apps/web` — Frontend dashboard (Phase 7)
- `packages/db` — Drizzle schema, migrations, client factory; imported by API, consumer, ETL, and relay workers
- `packages/contracts` — Shared Zod schemas (request/response DTOs), single source of truth for validation

---

## 3. Data Model & Invariants

### 3.1 Core Tables

**`sites`** — Emission-producing facilities.
- `id: bigserial` (internal FK target)
- `slug: text UNIQUE` (client-supplied, external identity, URL-safe `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)
- `name, latitude, longitude, location_label` — facility metadata
- `timezone: text` — IANA name (e.g., `America/Edmonton`), validated at the edge; required for clock-skew detection
- `emission_limit: numeric(18,6)` — compliance threshold in kg CO2e
- `created_at, updated_at` — server-timestamped

**`site_emission_points`** — Sub-sources within a site (vents, flares, compressors, etc.).
- `id: bigserial`, `site_id: bigint FK`, `code: text`
- Uniqueness: `UNIQUE(site_id, code)` — auto-created on first sight (Phase 4, Section 3.4)
- Per-site cache in Redis (`ep:<site_id>` HASH) for O(1) lookup on hot path

**`measurements`** — **PARTITIONED BY RANGE (recorded_at) monthly**. Append-only raw readings.
- `id: bigserial`, `site_id: bigint FK`, `emission_point_id: bigint FK`, `batch_id: uuid`, `recorded_at: timestamptz`, `value: numeric(18,6)` (kg CO2e)
- **Composite PK: `(id, recorded_at)`** — partition key must appear in any unique/primary constraint on partitioned tables (Postgres rule)
- **Authoritative dedupe: `UNIQUE(batch_id, emission_point_id, recorded_at)` + `ON CONFLICT DO NOTHING`** — microsecond `recorded_at` makes same-point-same-instant collisions implausible. This is the source of truth; Redis edge dedupe is an optimization.
- Supporting indexes: `(site_id, recorded_at DESC)` for per-site time-series reads; `(batch_id)` for batch tracing.
- **Partitions:** Current month + 3 ahead (monthly boundaries at midnight UTC) + DEFAULT catch-all. Monthly rollover script (Phase 5) extends the window; if missed, rows silently land in DEFAULT (surfacing the operational miss while preserving correctness).
- Foreign keys use `ON DELETE RESTRICT` — measurements cannot be orphaned.

**`site_monthly_emissions`** — Cached per-(site, year, month) aggregate of measurements.
- **Not a live `total_emissions_to_date` column.** This is the deliberate scaling deviation from the README (Section 3.2 below).
- `site_id, year, month` — composite PK; `total_kg` (numeric(18,6)), `stale` (boolean), `computed_at` (timestamptz)
- Populated by the nightly ETL at 02:00 UTC on day 2 of month M+1 (Phase 5)
- `stale=true` marks rows invalidated by late arrivals; hourly job scans `WHERE stale = true` and recomputes only affected (site, year, month) tuples (Phase 5)
- `GET /sites/:slug/metrics` computes total = SUM(monthly aggregates for prior months) + SUM(measurements for current month, filtered by `recorded_at`) — eventually consistent, not atomic with ingest

**`outbox`** — Transactional outbox for business events emitted by the ingest consumer (Phase 4/5).
- `id, event_type, aggregate_id, payload (jsonb), created_at, available_at, attempts, last_error, delivered_at`
- One row per ingest batch, not per measurement. Payload: `{ site_id, batch_id, count_inserted, sum_kg }`
- Relay polls: `SELECT ... WHERE delivered_at IS NULL AND available_at <= now() FOR UPDATE SKIP LOCKED`
- Exponential backoff via `available_at` rewrites on transient failure; `attempts` counter tracks retries
- Partial index `(available_at) WHERE delivered_at IS NULL` keeps relay scan cheap

**`system_alerts`** — Sibling table to `outbox`, same retry-aware shape. Carries operational events (clock skew violations, downstream failures). Managed by a separate `apps/system-alerts` relay worker (Phase 5).

### 3.2 Scaling Trade-off: Monthly Aggregates Instead of Live Totals

**The deviation:** The README implies a live `sites.total_emissions_to_date` column updated atomically with each ingest. We do not store that column.

**Why:** Recomputing `total_emissions_to_date` on every ingest does not scale to 100M+ measurements. A single UPDATE on the `sites` row becomes a hot-spot under concurrent ingest; every writer serializes on that one row, killing throughput. The original Phase 1 plan used `SELECT ... FOR UPDATE` pessimistic locking to protect it; that's correct but expensive.

**What we do instead:**
1. Ingest persists raw measurements to the partitioned `measurements` table (no site-row touch).
2. Nightly ETL (02:00 UTC on day 2 of month M+1) closes the prior month: SUM all measurements for that (site, year, month) and INSERT or UPDATE `site_monthly_emissions`.
3. Late arrivals after month-close are allowed — they flag the affected row `stale=true`.
4. Hourly job recomputes only the stale rows, marking them `stale=false` after rebuild.
5. `GET /sites/:slug/metrics` is eventually consistent: it queries closed months from the cache table and the current month from raw measurements. Lag is typically sub-second (Kafka consumer drains quickly) but not atomic.

**Trade-off:** We gained scalability (no hot-spot UPDATE, scales to billions of rows) and lost strict atomicity on `/ingest` (response is 202 "queued," metrics are eventually consistent). **This is intentional and documented.** Regulatory compliance requires correctness, not real-time; the ETL and recompute logic guarantee eventual consistency to the second, which satisfies OGMP 2.0 audit trails.

---

## 4. Ingestion Pipeline

### 4.1 HTTP API → Kafka Edge

**`POST /ingest` handler (Phase 4):**
1. Zod validate request envelope (batch_id, site_slug, readings array, client timestamp)
2. Check site exists (API lookup or Redis SET in future phases)
3. **Redis edge dedupe:** `HSETNX + HEXPIRE` on per-site hash `dedupe:<site_slug>`, field = `batch_id`, 24h TTL (default)
   - Returns true if first sight, false if duplicate
   - Atomic via Lua script (apps/api/src/redis/redis.module.ts)
   - If duplicate, return 202 with `stale=true` flag so client knows to not retry
4. Produce to Kafka topic `emissions.ingest.v1`, key = `site_slug` (preserves per-site ordering), value = batch + readings
5. Return 202 Accepted with `{ batch_id, status: "queued", stale: false }`

**Why key by `site_slug`:** Kafka guarantees that all messages with the same key land on the same partition, and each partition is processed by **exactly one consumer instance at a time** (within a consumer group). So keying by `site_slug` means no two consumers ever process the same site concurrently — the per-site write stream is naturally serialized without any explicit locking on the consumer side.

This matters because the consumer auto-creates emission points on first sight via `INSERT ... ON CONFLICT (site_id, code) DO NOTHING`. If two consumers were racing to create the same emission point, the loser would still complete safely (the ON CONFLICT handles it), but it'd produce wasted transactions and unnecessary lock contention on the `site_emission_points` row. Per-site partitioning eliminates that contention by construction.

It also reduces the spec's "10 concurrent writers against one site" stress scenario to a *single* consumer processing 10 messages back-to-back, with the consumer's process-local emission-point cache reused across every batch (and across every site that consumer owns). No per-site cross-consumer concurrency to worry about — only the rare cross-instance race during a partition rebalance, which the SQL `ON CONFLICT` primitives still handle correctly (see §12.1).

**Why Kafka:** Decouples response time (few ms, just produce) from the transactional work (consumer). Field devices see fast ACK even if downstream is slow. Failures in the consumer don't block the ingestion endpoint.

**Idempotency layers:**
1. **Redis (optimization):** Edge deduplication; prevents duplicate Kafka messages on client timeout + retry
2. **Postgres (authoritative):** Unique index on `(batch_id, emission_point_id, recorded_at)` + `ON CONFLICT DO NOTHING`; catches duplicates even if Redis restarts and forgets the cache

### 4.2 Kafka Consumer → Postgres Transaction (Phase 4)

**Atomic transaction per batch (apps/consumer/src/ingest/ingest-handler.service.ts):**

```
Consumer subscribes to emissions.ingest.v1, keyed by site_slug
(per-site ordering preserved via Kafka partitioning)

For each consumed message:
  -- Pre-tx reads (no BEGIN yet). The FK on measurements still enforces
  -- validity at insert time, so reading these outside the tx is safe and
  -- keeps the tx short.
  SELECT id FROM sites WHERE slug = ?;  -- no FOR UPDATE
    -- if no row: write system_alerts row, ack the offset, return

  -- Resolve emission_point code → id via tiered lookup:
  --   1. Process-local cache (steady-state: zero DB calls).
  --   2. One batched SELECT … WHERE site_id = ? AND code = ANY(missing)
  --      for cache misses (cold batch).
  --   3. One batched INSERT … ON CONFLICT (site_id, code) DO NOTHING
  --      RETURNING for genuinely-new codes (rare path).
  --   4. One batched re-SELECT for the cross-instance race where another
  --      writer created the row between (2) and (3).
  -- Sorted code order in step (3) keeps lock acquisition deterministic.

  BEGIN TRANSACTION;
    INSERT INTO measurements (..., batch_id, emission_point_id, recorded_at, value)
      VALUES (...), (...), ...
      ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING
      RETURNING id, recorded_at, value;  -- only inserted rows

    FOR each (year, month) from inserted measurements (sorted):
      INSERT INTO site_monthly_emissions (site_id, year, month, total_kg, stale)
        VALUES (?, ?, ?, 0, FALSE)
        ON CONFLICT (site_id, year, month) DO UPDATE SET stale = TRUE;

    INSERT INTO outbox (event_type, aggregate_id, payload, ...)
      VALUES ('ingest.batch.persisted', site_slug, {
        site_slug, batch_id, measurements_inserted, sum_kg_co2e, ...
      });
  COMMIT;

  Commit Kafka offset (at-least-once semantics)
```

**Locking strategy: no `FOR UPDATE` on the site row.**

Concurrent safety is guaranteed entirely by SQL primitives at `READ COMMITTED` isolation:
- Emission-point resolution uses a tiered cache → batched-SELECT → `INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING` → batched re-SELECT pattern. The `ON CONFLICT` + re-SELECT path only fires on the rare cross-instance race during a partition rebalance; steady-state batches resolve from a process-local cache with zero DB calls. (See §5.4 and §12.1 for the full sequence.)
- `INSERT … ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING` with the unique index ensures dedupe even if the same Kafka message is delivered twice.
- `INSERT … ON CONFLICT (site_id, year, month) DO UPDATE SET stale = true` handles concurrent monthly-aggregate stale-flag updates.
- Kafka partitioning by `site_slug` serializes all traffic for one site to a single consumer instance, making per-site concurrency between different batches extremely unlikely.

Deterministic lock ordering (sorting new emission-point codes before the `INSERT ON CONFLICT` step and `(year, month)` pairs before the stale-flag update) prevents deadlocks under the spec's "10 concurrent writers" scenario by ensuring concurrent transactions acquire tuple locks in the same order (`apps/consumer/src/ingest/ingest-handler.service.ts`).

**Why not pessimistic locking?** The original Phase 1 plan used `SELECT … FOR UPDATE` to serialize updates to `sites.total_emissions_to_date`, but that column was replaced by monthly aggregates in §3.2. The remaining contention surface — first-time emission-point creation and monthly-aggregate stale-flag writes — is correctly and efficiently handled by SQL `ON CONFLICT` semantics without row-level locks. Pessimistic locking would add latency (brief but measurable under load) without improving correctness. Verdict: **SQL-primitive optimistic pattern** (Entry 7.3 concurrency audit).

### 4.3 Clock Skew Detection

A measurement with `recorded_at` in the future **relative to the site's local time** is rejected (4xx) and an entry is written to `system_alerts`:

```typescript
// Pseudocode
const siteLocalNow = Temporal.Now.zonedDateTimeISO(site.timezone);
const recordedLocalTime = Temporal.Instant.from(reading.recorded_at)
  .toZonedDateTimeISO(site.timezone);
if (recordedLocalTime > siteLocalNow.add({ minutes: 5 })) { // 5-min grace
  writeSystemAlert("clock_skew_violation", { site_id, recorded_at, site_timezone });
  return 4xx;
}
```

This catches badly-synchronized field devices and surfaces the issue to ops (Phase 5, system-alerts relay logs it).

---

## 5. Idempotency: Layered Defense

### 5.1 Layer 1: Redis Edge Dedupe

**What:** Per-site HASH in Redis, field = `batch_id`, 24h TTL via `HEXPIRE`.

**How:**
```lua
-- Atomic Lua script
local key = "dedupe:" .. site_id
local result = redis.call("HSETNX", key, batch_id, "1")
if result == 1 then
  redis.call("HEXPIRE", key, 86400, "FIELDS", 1, batch_id)
end
return result
```

**Effect:** First call returns `1` (proceed), retry within 24h returns `0` (skip produce). If Redis restarts, the cache is lost (new HSET returns `1`), causing the next attempt to publish a duplicate to Kafka — but that's OK, the DB layer catches it.

**Design notes:**
- Per-site HASH (not per-batch key) — memory efficiency for millions of batches; HASH operations are O(1) per field
- 24h TTL chosen as a practical window (devices rarely retry after 24h without human intervention); tunable via `BATCH_DEDUPE_TTL_SECONDS` in `.env`
- Active defragmentation in Redis (`--activedefrag yes`) mitigates fragmentation from millions of hash fields; see Entry 2.6 for the deliberate choice of `redis:7.4-alpine` + `HEXPIRE`

### 5.2 Layer 2: Kafka Idempotent Producer (Producer-Side)

**What:** KafkaJS producer configured with `idempotent: true`, which engages Kafka's idempotent-producer protocol on the broker side.

**How:** In `apps/api/src/kafka/kafka.module.ts`:

```typescript
this.producer = this.kafka.producer({
  idempotent: true,
  maxInFlightRequests: 1,
  retry: { retries: 5 },
});
```

With `idempotent: true`, every produce request is stamped with a producer ID + per-partition sequence number. The broker tracks the highest sequence it has accepted per `(producerId, partition)` pair and rejects out-of-order or duplicate sequences. So if a network blip causes the producer to retry the same message, the broker writes it to the log **exactly once** — the second copy is silently dropped at the broker.

**Why `maxInFlightRequests: 1`:** the idempotent-producer guarantee requires strict in-order delivery per producer-partition. Allowing >1 in-flight request would let acks return out of order, and a retry could end up reordering messages on the log. KafkaJS enforces this constraint when `idempotent: true`.

**Where this layer sits between Redis and Postgres:**
- Redis (Layer 1) catches **client-driven** retries (same `batch_id` resubmitted by the field device).
- The idempotent producer catches **producer-driven** retries (same Kafka message resubmitted after a transient broker/network error inside `apps/api`).
- Postgres (Layer 3, below) catches everything either of those layers might miss (Redis flush, blue/green deploy, consumer crash between DB commit and Kafka offset commit).

Each layer narrows the surface for the next; the bottom layer is authoritative.

### 5.3 Layer 3: Postgres Unique Index (Authoritative)

**What:** `UNIQUE(batch_id, emission_point_id, recorded_at)` on `measurements` table.

**How:** Consumer's `INSERT ... ON CONFLICT DO NOTHING` silently ignores duplicate rows.

**Why `recorded_at` in the dedupe key?**
- Postgres requires the partition key to be present in any unique constraint on a partitioned table (hard rule)
- Microsecond `recorded_at` precision makes same-point-same-microsecond collisions implausible for physical sensors (devices in the field don't tick that tightly)
- If a device retransmits the same reading hours later with a fresh `batch_id`, it's a new logical batch and should be counted — the unique index doesn't prevent that (and neither should we)

**RETURNING count:** After `INSERT ... ON CONFLICT DO NOTHING`, we count rows actually inserted (not rejected):
```sql
INSERT INTO measurements (...) VALUES (...)
ON CONFLICT DO NOTHING
RETURNING *;  -- Only returns inserted rows, not conflicts
```

The sum of `value` from the returned rows is what gets added to the monthly aggregate (or buffered in the outbox). This ensures retried batches don't double-count.

### 5.4 Unit of Idempotency

**`batch_id` is the unit of idempotency — not the measurements array.** The Redis edge dedupe inspects only `batch_id`; the Postgres unique index inspects `(batch_id, emission_point_id, recorded_at)`. A client that retries the same `batch_id` with a *different* measurements array has the second payload silently dropped at the Redis edge (and the unique index would reject it at the DB anyway because the new readings collide with the old `batch_id`).

**Contract for clients:** if you need to add, remove, or change measurements, issue a fresh `batch_id`. Reusing a `batch_id` is the explicit declaration that "this is the same batch as before; if you've already accepted it, do nothing." Pinned by `apps/api/test/integration/ingest.idempotency.test.ts` Test 5.

### 5.5 Outbox Multiplicity (Important for the Relay)

**The outbox can carry multiple rows per `batch_id` by design.** Cases:
- **Redis-bypassed retry:** TTL expiry, manual `HDEL`, or Redis restart clears the dedupe entry. Client resubmits the same batch → new Kafka message → consumer writes `INSERT … ON CONFLICT DO NOTHING` (0 rows inserted) and writes outbox with `measurements_inserted: 0`.
- **Consumer crash between DB commit and Kafka offset commit:** Transaction persists measurements + outbox, but consumer process dies before committing the Kafka offset. Kafka redelivers the message → consumer retries the transaction → unique index catches duplicates → outbox row written with `measurements_inserted: 0`.
- **Blue/green deploy:** Two consumer replicas briefly running under different group IDs pick up overlapping Kafka partitions. Same Kafka message processed twice → two outbox rows, second with `measurements_inserted: 0`.

**Contract for the relay and alerting receiver:**
- Dedupe on `(event_type, aggregate_id, batch_id)` via in-memory bounded-LRU set (apps/alerting/src/alerts/alerts.service.ts).
- Suppress notifications when `payload.measurements_inserted == 0` (duplicate batches with zero new data).
- Log `alert.delivered` or `alert.duplicate_suppressed` depending on outcome (structured JSON to stdout).

Enforced by `apps/api/test/integration/ingest.idempotency.test.ts` Tests 2 (single-shot idempotency), 5 (batch_id is the unit, not the array), and 7 (outbox multiplicity).

### 5.6 Consumer-Permanent-Failure Lockout (Known Limitation)

**Scenario:** Consumer transaction permanently aborts (poison data, FK violation, numeric overflow). The API has already returned `202 Accepted` to the client and recorded the `batch_id` in the Redis dedupe hash. When the client retries with a corrected payload and same `batch_id`, the Redis edge returns `stale: true` (duplicate), silently dropping it. The client has no way to know the original attempt failed or to resubmit with a new `batch_id`.

**Current behavior:** Consumer writes a `system_alerts` row (ops can see the failure via the alerting relay logs), but the API client sees only `202` and eventual silence — no feedback that the batch permanently failed.

**Recommended mitigations (not yet implemented):**
1. **Admin endpoint** — `DELETE /admin/ingest/dedupe/:slug/:batch_id` (credentials gated) to clear a stuck entry and allow retry.
2. **Shorter TTL** — Reduce `BATCH_DEDUPE_TTL_SECONDS` default from 24h to 1h, limiting the lockout window.
3. **Consumer signal-back** — Consumer writes `batch_failed:<batch_id>` to Redis on hard-fail; API checks this set before returning `202` and signals client to retry with a new `batch_id`.

Phase deferred; tracked in `docs/PLAN.md` Entry 7.3.

---

## 6. Response Envelope & Error Model

### 6.1 Shape

All API responses conform to a unified envelope (bonus #7, locked in Entry 1.2, implemented in Phase 2):

**Success (2xx):**
```json
{
  "ok": true,
  "data": { ... }
}
```

**Error (4xx / 5xx):**
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL",
    "message": "Human-readable message",
    "details": { ... },
    "request_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### 6.2 Error Codes

| Code | HTTP | Cause | Example |
|------|------|-------|---------|
| `VALIDATION_FAILED` | 400 | Request body fails Zod schema, timezone invalid, clock skew, site slug invalid | `{ "code": "VALIDATION_FAILED", "details": { "field": "timezone", "message": "Invalid IANA timezone" } }` |
| `NOT_FOUND` | 404 | Site not found, health check when DB is down (grace, does not crash) | `{ "code": "NOT_FOUND", "message": "Site with slug 'unknown' not found" }` |
| `CONFLICT` | 409 | Site slug already exists | `{ "code": "CONFLICT", "message": "Site slug 'well-pad-1' already exists" }` |
| `RATE_LIMITED` | 429 | Too many requests from IP (future feature, placeholder for bonus #6) | — |
| `INTERNAL` | 500 | Database error, unexpected exception | `{ "code": "INTERNAL", "message": "Internal server error", "request_id": "..." }` |

### 6.3 Implementation

**Global `ExceptionFilter`** (Phase 2, `apps/api/src/common/envelope/http-exception.filter.ts`):
- Catches all NestJS exceptions and framework errors
- Maps to the enum above
- Logs the full stack trace internally, returns sanitized message to client
- Attaches `request_id` from the context
- Extracts structured `{ message, details }` from `HttpException.getResponse()` so services can throw `new ConflictException({ message, details })` and have both fields propagate without per-exception mapping
- Maps Postgres `23505` (unique violation) → `CONFLICT` as a belt-and-suspenders fallback when a service forgets to catch the constraint itself

**Global `ResponseInterceptor`** (Phase 2, `apps/api/src/common/envelope/response.interceptor.ts`):
- Wraps successful responses in `{ ok: true, data }`
- Injects `request_id` into response headers for client logging

**Wiring (important for testability):** both globals are registered as `APP_FILTER` / `APP_INTERCEPTOR` **providers in `AppModule`**, not via `app.useGlobalFilters()` / `app.useGlobalInterceptors()` in `main.ts`. `useGlobalX()` only applies when `main.ts` runs the bootstrap, which means Jest tests bootstrapping `AppModule` directly (or any future microservice / hybrid app) would silently bypass the envelope. The provider form applies identically in every bootstrap context. `main.ts` therefore only owns bootstrap-time concerns (logger swap, CORS, shutdown hooks, `listen`); platform behavior lives in the module graph.

### 6.4 Request Pipeline End-to-End

Every request traverses the same five-stage chain, regardless of which endpoint it lands on. The platform owns stages 1, 2, 3, and 5; the controller owns only stage 4. The exception filter is an alternate exit that catches anything thrown at any stage and produces the matching error envelope.

```
                 POST /sites { slug, name, country, ... }
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 1. RequestIdMiddleware                              │
   │    Reads x-request-id header or generates UUID;     │
   │    sets req.id; echoes header back on response.     │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 2. pino-http (logs request line with request_id)    │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 3. ZodValidationPipe(CreateSiteSchema)              │
   │    safeParse the body. On failure: throw ZodError.  │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 4. Controller method (SitesController.create)       │
   │    Returns plain object: SiteResponse.              │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 5. ResponseInterceptor                              │
   │    Wraps return value: { ok: true, data: ... }.     │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
                  201 { ok: true, data: { ... } }


                  If anything threw at any stage:
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ AllExceptionsFilter                                 │
   │    ZodError → 400 VALIDATION_FAILED                 │
   │    HttpException → status + matching code           │
   │    Postgres 23505 → 409 CONFLICT                    │
   │    other → 500 INTERNAL + log stack                 │
   │    All include request_id.                          │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
                  4xx/5xx { ok: false, error: { code, message, request_id } }
```

The shape of this pipeline is what makes the envelope guarantee structural rather than aspirational: controllers cannot accidentally skip validation, return an unwrapped body, or leak an unmapped error — those failure modes require bypassing the framework, not just forgetting a line.

---

## 7. Request ID & Observability

### 7.1 Request ID Propagation

Every HTTP request is assigned a unique ID (UUID v7 if available, else v4) used for end-to-end tracing:

1. **Inbound:** Read `x-request-id` header if present (e.g., from a tracing proxy); fall back to generating a new UUID v7
2. **Middleware:** `RequestIdMiddleware` attaches the ID to `req.id` early in the NestJS lifecycle
3. **Pino integration:** `nestjs-pino` reads `req.id` and binds it to every log line in that request's context
4. **Outbound:** Echo `x-request-id` header on all responses so clients can correlate their logs with ours
5. **Error responses:** Include `request_id` in the error payload for customer support ("my request ID is X, what happened?")

### 7.2 Structured Logging

**Logger:** `pino` (Node.js structured JSON logger), integrated via `nestjs-pino@13.x`

**Dev mode:** Pretty-printed human-readable logs to stdout
**Prod mode:** JSON lines to stdout, each line with:
```json
{
  "time": "2026-05-18T10:30:45.123Z",
  "level": "info",
  "pid": 12345,
  "hostname": "api-container",
  "req": { "id": "550e8400-...", "method": "POST", "url": "/ingest", "remoteAddress": "..." },
  "event": "ingest.batch.received",
  "site_id": 42,
  "batch_id": "...",
  "msg": "batch queued successfully"
}
```

**Redactions (Phase 2+):** Measurement payloads and sensitive headers (Authorization, Cookie) are excluded from logs to avoid accidentally leaking customer data.

---

## 8. Configuration & CORS

### 8.1 Environment Validation

**Zod-validated schema** (`apps/api/src/config/env.schema.ts`):
```typescript
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});
```

- `DATABASE_URL` is required; missing or malformed → fail at bootstrap with clear message
- Other env vars have sensible defaults; override as needed
- `CORS_ALLOWED_ORIGINS` empty in dev (permissive), required in prod with explicit allowlist (fail-secure model)

### 8.2 CORS Policy

- **Dev (`NODE_ENV=development`):** CORS enabled globally; any origin accepted
- **Prod (`NODE_ENV=production`):** CORS disabled by default; only origins in `CORS_ALLOWED_ORIGINS` (space-separated list) are allowed. Missing the list → deny all, safe default.

---

## 9. Shared Contracts (Zod Schemas)

### 9.1 Purpose

`packages/contracts` is the single source of truth for request/response shapes. Schema changes are made once, propagated to both backend and frontend. TypeScript types are inferred from Zod schemas; no manual DTO classes.

### 9.2 Files & Exports

- `common.ts` — Shared building blocks: `SiteSlugSchema`, `BatchIdSchema`, `TimezoneSchema`, etc.
- `envelope.ts` — Response envelope: `SuccessEnvelope<T>`, `ErrorEnvelope`, error codes
- `sites.ts` — `CreateSiteSchema`, `SiteResponseSchema`
- `ingest.ts` — `IngestBatchSchema`, `IngestBatchResponseSchema`
- `metrics.ts` — `SiteMetricsResponseSchema`

### 9.3 Integration

**NestJS (backend):** `nestjs-zod` pipe auto-validates request bodies:
```typescript
@Post('ingest')
async ingest(@Body(ZodValidationPipe) payload: IngestBatchPayload) { ... }
```

**Next.js (frontend, Phase 7):** Same schemas used for form validation and runtime type safety:
```typescript
const form = useForm<z.infer<typeof IngestBatchSchema>>({
  resolver: zodResolver(IngestBatchSchema),
});
```

### 9.4 Distribution

`packages/contracts` ships TS sources directly (no `dist/`), matching `packages/db`'s convention. Every app that imports `@highwood/contracts` must bundle it into the production build (see Section 10 below).

---

## 10. Build & Production Deployment (Planned details)

### 10.1 Production Bundling

**Problem:** `packages/db` and `packages/contracts` are TS-sources only (no compiled `dist/`). In dev, all apps run via `tsx` (TS runtime), so sources are directly importable. In production, the bundle must inline them.

**Solution:** `apps/api` (and future consumer/relay apps) use `tsup` with `noExternal: ["@highwood/contracts", "@highwood/db"]`:
```typescript
// tsup.config.ts
export default {
  entry: ["src/main.ts"],
  format: ["esm"],
  bundle: true,
  noExternal: ["@highwood/contracts", "@highwood/db"],
  esbuildOptions: (options) => {
    options.define = { "require.resolve": undefined };
  },
};
```

**Output:** Single `dist/main.js` (ESM) containing API logic + inlined Drizzle types + inlined Zod schemas. No runtime dependency on `node_modules/@highwood/*`.

**Implication:** Consumer, ETL, and relay workers (Phase 4+) must have their own `tsup.config.ts` with the same bundling setup. Failure to bundle → `Cannot find module '@highwood/db'` at runtime in the production image.

### 10.2 `@swc/core` Requirement

`tsup` uses esbuild under the hood, which does not natively emit TypeScript decorator metadata. NestJS requires decorator metadata for dependency injection:

```typescript
@Injectable()
export class SomeService {
  constructor(private db: DbClient) { }  // <-- needs Reflect.metadata() calls
}
```

**Solution:** Add `@swc/core` to devDependencies. Activate in `tsup.config.ts`:
```typescript
export default {
  ...
  esbuildOptions: (options) => {
    options.minify = false;  // let esbuild + swc pipeline handle it
  },
};
```

(Already done in Phase 2 for `apps/api`; must be repeated for consumer, ETL, alerting, and system-alerts.)

### 10.3 Docker Image Strategy (Phase 6+)

Expected production Dockerfile:
```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY apps/api/dist/main.js /app/server.js
COPY node_modules /app/node_modules  # minimal: only runtime prod deps (rxjs, pino, postgres, zod)

EXPOSE 3000
CMD ["node", "server.js"]
```

Critically: no `packages/db/src/` or `packages/contracts/src/` needed in the image (they are bundled into `main.js`).

---

## 11. Databases & Migrations

### 11.1 Schema Definition & Migration Flow

1. **Drizzle schema files** (`packages/db/src/schema/*.ts`) define the logical table structure (columns, types, constraints, indexes)
2. **`drizzle-kit generate`** diffs the schema against a migration history, emitting `packages/db/migrations/NNNN_description.sql` files
3. **Hand-written migrations** (e.g., `0001_partition_measurements.sql`) replace or augment auto-generated migrations for features Drizzle doesn't model (partitioning, triggers, etc.)
4. **`pnpm db:migrate`** runs all pending migrations in order against a live PostgreSQL database

### 11.2 Partitioning & Maintenance

**`measurements` table is partitioned by `recorded_at` (monthly RANGE):**

- Logical table: `measurements` (parent, no data stored directly)
- Child partitions:
  - `measurements_y2026_m05` for dates [2026-05-01, 2026-06-01)
  - `measurements_y2026_m06` for dates [2026-06-01, 2026-07-01)
  - `measurements_y2026_m07`, `measurements_y2026_m08` (pre-created)
  - `measurements_default` — catch-all for rows outside the pre-created windows

**Rollover script (Phase 5, to live in `apps/etl`):**
- Runs monthly on day 1 at 01:00 UTC, before the nightly ETL at 02:00 UTC
- Creates the next month's partition before its boundary is crossed
- If missed, rows land in DEFAULT (operationally visible, correctness preserved)

**Reclaiming DEFAULT (manual operation, documented in migration file):**
```sql
ALTER TABLE measurements DETACH PARTITION measurements_default;
CREATE TABLE measurements_y2026_m09 (LIKE measurements INCLUDING ALL);
INSERT INTO measurements_y2026_m09
  SELECT * FROM measurements_default
  WHERE recorded_at >= '2026-09-01' AND recorded_at < '2026-10-01';
DELETE FROM measurements_default WHERE recorded_at >= '2026-09-01' AND recorded_at < '2026-10-01';
ALTER TABLE measurements ATTACH PARTITION measurements_y2026_m09 FOR VALUES FROM (...) TO (...);
ALTER TABLE measurements ATTACH PARTITION measurements_default DEFAULT;
```

### 11.3 Postgres Driver

**`postgres` (postgres-js)** chosen over `pg` or `better-sqlite3`:
- Modern async/await, no callback spaghetti
- Supports prepared statements, transaction blocks, `COPY` streams
- Used by Drizzle and by the consumer for transactional `BEGIN ... COMMIT` blocks

### 11.4 Numeric Round-Trip Behavior

Postgres `numeric(18, 6)` columns canonicalize values to the full column scale on read. A client posting `"1000.50"` for `emission_limit` gets back `"1000.500000"` on the response and in any subsequent `GET`. The `NumericKgSchema` regex (`^\d{1,12}(\.\d{1,6})?$`) accepts both shapes, so client-supplied values are never rejected for trailing-zero variance — but clients must not assume their literal input string survives unchanged. Frontend code that compares a posted value to a server-echoed value should parse both as decimals (or trim trailing zeros) before comparing.

---

## 12. Data Integrity Guarantees

### 12.1 Atomic Ingest Transaction & Locking Strategy

The consumer's transaction is the atomicity boundary (not the HTTP request). Implemented in `apps/consumer/src/ingest/ingest-handler.service.ts`:

```sql
-- Pre-tx: site lookup. FK on measurements enforces validity at insert time,
-- so this read does not need to be inside the tx.
SELECT id FROM sites WHERE slug = ?;
  -- if no row: write system_alerts row, ack the Kafka offset, return.

-- Pre-tx: emission-point code → id resolution (tiered, mostly cache hits).
--   1. Process-local Map<`${siteId}:${code}`, id>. Steady-state: 0 DB calls.
--   2. One batched SELECT for cache misses (cold batch).
--   3. One batched INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING
--      for genuinely-new codes; sorted to keep lock acquisition deterministic.
--   4. One batched re-SELECT for the cross-instance race where another writer
--      created the row between (2) and (3) — e.g. after a partition rebalance.
-- Resolved ids are written back into the cache for future batches.

BEGIN TRANSACTION;  -- READ COMMITTED (default)
  -- Bulk insert measurements with authoritative dedup
  INSERT INTO measurements (...)
    ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING
    RETURNING id, recorded_at, value;

  -- Mark affected months stale; (year, month) pairs sorted for deterministic ordering
  FOR each affected (year, month):
    INSERT INTO site_monthly_emissions (site_id, year, month, ...)
      ON CONFLICT (site_id, year, month) DO UPDATE SET stale = true;

  -- One outbox row per batch, regardless of dedupe outcome
  INSERT INTO outbox (event_type, aggregate_id, payload, available_at) VALUES (...);
COMMIT;

-- Then: commit Kafka offset (at-least-once semantics)
```

**Why emission-point resolution moved outside the tx.** Emission-point rows are append-only and the FK on `measurements` enforces validity at the moment of insert, so the resolved id remains valid when the tx opens. Resolving outside the tx (a) shortens the tx and reduces lock-hold time, and (b) lets steady-state batches answer from a process-local cache without touching the DB at all. The previous in-tx pattern issued a speculative `INSERT … ON CONFLICT DO NOTHING` per unique code per batch — correct, but wasted work in the common case where the row already existed.

**Atomicity guarantee:** All writes succeed or all rollback. Partial batches are impossible. If transaction commits, the outbox row exists and the relay will eventually deliver it.

**Idempotency on retry:** Rerun with same `batch_id` and measurements unchanged → the unique index on `(batch_id, emission_point_id, recorded_at)` drops duplicates silently, returning 0 rows. Consumer writes a second outbox row with `measurements_inserted: 0`. The relay (and alerting receiver) dedupe on `batch_id`, suppressing the no-op notification.

**Locking strategy: SQL primitives, no `FOR UPDATE`.** The original Phase 1 design called for `SELECT … FOR UPDATE` on the site row to serialize emission-point auto-creates and updates to `sites.total_emissions_to_date`. That column was replaced by monthly aggregates (§3.2), eliminating the hot-row contention.

Current strategy uses SQL-level concurrent-safety constructs at `READ COMMITTED` isolation:
- Emission-point resolution: cache → batched `SELECT` → batched `INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING` → batched re-`SELECT`. The `INSERT ON CONFLICT` and re-`SELECT` only fire for genuinely-new codes or the rare cross-instance race; the steady-state path is cache-only.
- `INSERT … ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING` atomically dedupes measurements via the unique index.
- `INSERT … ON CONFLICT (site_id, year, month) DO UPDATE SET stale = true` atomically marks months as needing recompute.

Kafka partitions by `site_slug`, which routes all traffic for one site to a single consumer instance, making per-site concurrency (different batches for the same site in parallel) extremely unlikely. When it does occur, the SQL primitives above handle it safely without row-level locks. Deterministic sort ordering of the new-code `INSERT` batch and the `(year, month)` upsert sequence ensures that concurrent transactions acquire tuple locks in the same order, eliminating the deadlock risk even under the spec's "10 concurrent writers" scenario (Entry 7.3 concurrency audit verdict).

**Why SQL primitives over pessimistic locking?** The `ON CONFLICT` path is simpler, requires no explicit locks (reducing latency under load), and is provably correct at `READ COMMITTED` isolation. Pessimistic locking (`FOR UPDATE`) would add lock-hold time without improving correctness and is not needed given the architecture's other invariants.

### 12.2 Transactional Outbox & Alerting Relay (Phase 5)

**The guarantee:** One outbox row per batch is written in the **same transaction** as the measurement inserts. If the transaction commits, the row exists in Postgres. A separate background relay then polls and delivers the notification, decoupled from the ingest path.

```
Ingest consumer:
  BEGIN TX → insert measurements → flag months stale → write outbox row → COMMIT
  (all-or-nothing; partial batches impossible)

Outbox relay (apps/outbox-relay):
  Loop every OUTBOX_POLL_INTERVAL_MS:
    BEGIN TX
      SELECT ... FROM outbox
      WHERE delivered_at IS NULL AND available_at <= now()
      FOR UPDATE SKIP LOCKED
      LIMIT OUTBOX_BATCH_SIZE  (default 25)
    
    For each row:
      POST /alerts/business (with X-Idempotency-Key header)
      If 2xx → UPDATE delivered_at = now() in same TX
      If error → increment attempts, set last_error, push available_at forward
      If attempts >= OUTBOX_MAX_ATTEMPTS → INSERT system_alerts row (exhaustion), leave outbox alone
    
    COMMIT TX (mark delivered or reschedule)

System-alerts relay (apps/system-alerts):
  Parallel worker with the same poll shape, but scans `system_alerts` table
  On delivery failure, logs a `system_alerts_exhausted` event (no recursive system_alerts row)
```

**Schema:**
- `outbox` table (apps/consumer writes): `id`, `event_type`, `aggregate_id` (site_slug), `payload` (jsonb), `created_at`, `available_at`, `attempts`, `last_error`, `delivered_at`
- Partial index: `outbox_pending_idx (available_at) WHERE delivered_at IS NULL` — keeps relay scan cheap regardless of historical row count
- `system_alerts` table (consumer writes, relay drains): same shape, `alert_type` instead of `event_type`, `severity` text enum

**Relay backoff:** `min(2^attempts * baseSeconds, capSeconds) + jitter`. Configurable via `OUTBOX_BACKOFF_BASE_SECONDS`, `OUTBOX_BACKOFF_CAP_SECONDS`, `OUTBOX_MAX_ATTEMPTS` (default base=1s, cap=300s, max=10). On exhaustion, the outbox row is frozen with `available_at` set ~1 year in future; never deleted (forensic audit trail). Operators can manually unfreeze by setting `available_at = now()` and resubmit.

**Receiver-side deduplication (apps/alerting):** Validates Zod schema, dedupes business alerts on `(event_type, aggregate_id, payload.batch_id)` via in-memory bounded-LRU set (max 10K entries). Suppresses notifications when `payload.measurements_inserted == 0` (duplicate batches with no new data). Logs `alert.delivered` / `alert.duplicate_suppressed` / `system_alert.delivered` structured events; no persistence (sink only).

**`FOR UPDATE SKIP LOCKED` pattern:** Multiple relay replicas can run safely without coordination. `SKIP LOCKED` avoids lock waits by returning only uncontended rows in the batch, allowing each replica to process disjoint subsets in parallel. This is optimal for a low-coordination multi-writer scenario (blue/green deploys, horizontal scaling) at the cost of slightly higher miss rates under heavy load (acceptable for a background job).

**Why outbox over direct call?** Direct HTTP POST from the ingest consumer → alerting service would lose notifications if the consumer crashes between committing the DB and POSTing. The outbox decouples atomicity: the DB commit is the "write succeeded" signal; the relay is a separate concern that eventually (and idempotently) delivers the event. This is the transactional inbox/outbox pattern (bonus #4).

**Process isolation:** `apps/outbox-relay` and `apps/system-alerts` are separate NestJS worker processes with separate DB connection pools. Business-event delivery and operational-alert delivery do not share fate — a hung alerting receiver doesn't block system-alerts from being drains, and vice versa.

---

## 12.5 Testing Strategy

**Real Postgres, no mocks.** The take-home explicitly rewards "real database, real concurrency" — so the test harness uses Jest + ts-jest + supertest against an actual running Postgres. Mocking the DB layer would erase the very behavior under test (constraints, transactions, partition routing, unique violations).

**Current implementation (Phase 3):**
- `apps/api/test/integration/` — integration tests bootstrap `AppModule` via `NestFactory.create()`, run Drizzle migrations against `DATABASE_URL`, truncate tables between tests with `TRUNCATE … RESTART IDENTITY CASCADE`.
- Tests assert the response envelope shape explicitly (not just status codes) — the envelope is platform behavior and must be in every assertion.
- The 8 `POST /sites` tests cover happy path, optional-field handling, five distinct validation rejections, and duplicate-slug conflict. Each test verifies both the response and the persisted row.
- `LOG_LEVEL=silent` set in `setup-after-env.ts`; the `LoggerModule` reads `process.env.LOG_LEVEL` first so pino doesn't drown the test output.

**Known gaps (deferred to Phase 8):**
- **Testcontainers retrofit.** Currently tests run against the shared `docker-compose` Postgres rather than per-suite ephemeral containers. Practical implication: state isolation depends on `TRUNCATE` between cases, and parallel test runs would conflict. The `testcontainers` + `@testcontainers/postgresql` deps are installed; the swap is mechanical. Concurrency and idempotency tests (Phase 8) require true isolation and will trigger this retrofit.
- **Migration helper consolidation.** The test helper inlines a Drizzle migrator call rather than reusing `packages/db/src/migrate.ts`. Two places to maintain. Refactor when Phase 8 lands.
- **Concurrency + idempotency suites** — owned by `concurrency-expert` and `idempotency-reviewer` respectively. Will run against Testcontainers Postgres once the retrofit is in.

**Why APP_FILTER/APP_INTERCEPTOR as providers matters for tests:** see §6.3 — registering them in `main.ts` only would mean tests silently see unwrapped responses, which is exactly the bug Phase 3 surfaced. The provider form is the only correct pattern in a project that has both an HTTP bootstrap and a test bootstrap.

---

## 13. Open Decisions & Deferrals

| Decision | Status | Reference |
|----------|--------|-----------|
| Consumer locking strategy | ✓ Locked (Phase 4) | §4.2: SQL-primitive optimistic + deterministic sort ordering; no FOR UPDATE |
| Outbox relay backoff & exhaustion | ✓ Locked (Phase 5) | §12.2: exponential backoff, max-attempts → system_alerts, rows never deleted |
| Stale-flag trigger | ✓ Locked (Phase 4) | App-side write in consumer after each ingest; no SQL triggers |
| Consumer-permanent-failure dedupe lockout | Deferred | §5.6: three mitigation options; none implemented yet |
| Monthly rollover script automation | Deferred | Phase 6+ (currently manual; Section 11.2 documents the operation) |
| API versioning strategy (bonus #8) | Deferred | Planned as `/v1/` prefix + `Accept-Version` header if time permits |
| Dashboard retry UX | Deferred | Phase 7 (frontend reuses `batch_id` on error per idempotency contract) |
| Alerting receiver auth & DLQ | Deferred | Phase 5 explicitly out of scope (localhost stub only) |
| Frontend visibility into outbox state | Deferred | Phase 7 may surface delivery health, not Phase 5 |
| Deployment target & live URL | Deferred | Phase 9 (README submission decision) |
| Sequence diagrams & C4 models | Deferred | Phase 9 (or incrementally; not load-bearing) |

---

## 14. What We Didn't Do (And Why)

### 14.1 Explicit Decisions

- **Redis read-cache for sites/emission-points** — Postgres is fast enough; Redis is only for the dedupe HASH. Site/point lookups don't show up in profiling.
- **Multi-topic Kafka pipeline** — Single topic + staged processors simpler, same event-driven credit (bonus #2), fewer moving parts.
- **Optimistic concurrency by default** — Pessimistic locking is simpler, safer under the 10-concurrent-writers case. Optimistic only if profiling shows lock contention (not expected).
- **Live `total_emissions_to_date` column** — Would require hot-row UPDATE serialization, doesn't scale to 100M+ rows. Monthly aggregates + eventual consistency is the deliberate trade-off (Section 3.2).
- **PostGIS for location** — Numeric lat/lon + 6 decimals (11 cm precision) is sufficient; PostGIS as a dependency is overkill for this scope.
- **API versioning (bonus #8)** — Low ROI. If implemented late, will be a `/v1/` prefix with `Accept-Version` header.

### 14.2 Intentional Gaps

- **Soft deletes on sites** — Not in the README scope; hard delete (admin operation) is fine.
- **Audit trail of who ingested what** — Not required; could add `user_id` and `ingested_by` to measurements in Phase 7+ if multi-tenant access control is added.
- **Rate limiting per site or per IP** — Placeholder error code exists (`RATE_LIMITED`), implementation deferred to Phase 6+ if load testing surfaces issues.

---

## 15. Phase Roadmap (Reference)

Phases completed:

| Phase | Owner | Deliverables | ARCHITECTURE sections |
|-------|-------|--------------|----------------------|
| 0 | devx-infra | Workspace, Docker Compose, `.env.example`, single-command bootstrap | N/A (platform layer) |
| 1 | db-schema-designer | Schema, migrations, partitioning, `@highwood/db` | 3 (data model), 11 (migrations) |
| 2 | backend-architect | NestJS bootstrap, response envelope, request-id, observability, `@highwood/contracts` | 6, 7, 8, 9, 10 (platform primitives) |
| 3 | backend-architect | `POST /sites` endpoint, contract-driven development | Sections 6, 9 (envelope, contracts) |
| 4 | backend-architect | `POST /ingest`, Kafka consumer, locking choice, clock-skew detection, outbox write | Sections 4, 5, 12 |
| 4.3/4.4 | concurrency-expert, idempotency-reviewer | Audit verdicts, idempotency test suite, lock-ordering fixes | Section 12.1 (locking strategy finalized) |
| 5 | outbox-implementer | Outbox relay, alerting receiver, system-alerts relay (Phase 5 complete) | Section 12.2 (transactional outbox + relay) |
| 6 | backend-architect | `GET /sites/:slug/metrics`, `GET /sites?limit=&cursor=` | To be authored in next ARCHITECTURE refresh |
| 7 | frontend-builder | Dashboard, manual ingest form, retry UX | To be authored in next ARCHITECTURE refresh |
| 8 | qa-automation | Concurrency tests, idempotency tests, Testcontainers retrofit | To be authored in next ARCHITECTURE refresh |
| 9 | architecture-doc-writer | Final ARCHITECTURE.md polish, `docs/SETUP.md`, sequence diagrams | Incremental updates (this doc being Phase 5 refresh) |

---

## 16. Bonus Requirements Status

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | Concurrency Control | ✓ Done (Phase 4) | SQL-primitive optimistic pattern (ON CONFLICT + deterministic sort ordering); no row locks needed |
| 2 | Command/Processor Pattern | ✓ Done (Phase 4) | Consumer's `IngestHandlerService` uses structured transaction phases (apps/consumer/src/ingest/) |
| 3 | Partitioning (100M+ rows) | ✓ Done (Phase 1) | RANGE by `recorded_at` monthly; pre-created windows + DEFAULT (Phase 5 rollover deferred) |
| 4 | Transactional Outbox | ✓ Done (Phase 5) | One row per batch in same TX as measurements; relayed by `apps/outbox-relay` + `apps/system-alerts` |
| 5 | Developer Experience | ✓ Done (Phase 0) | Single `pnpm dev` command; migrations run automatically on boot |
| 6 | Observability (dupe metrics) | ✓ Done (Phase 4) | Logged in consumer as `inserted` vs. `duplicates` fields; counter easily added |
| 7 | Type-Safe Contracts (Zod) | ✓ Done (Phase 2) | `@highwood/contracts` consumed by backend (Nest validation pipes), frontend (form validation), and relays |
| 8 | API Versioning | Deferred | Low priority; `/v1/` prefix + `Accept-Version` header if time permits |

---

## 17. Cache-as-Authority on the Ingest Hot Path (Security Boundary)

> **The Redis `sites:valid` SET is the sole source of truth for slug validation on `POST /ingest`. A cache miss returns 404 without ever touching the database. This is a deliberate DOS-protection boundary, not an optimization, and it is load-bearing.**

### 17.1 The Threat

`POST /ingest` is a public, high-throughput endpoint. Before this design, it validated the inbound `site_slug` against Redis first and **fell back to a `SELECT FROM sites` on every cache miss**. That fallback was an amplification vector:

- Redis `SISMEMBER` is O(1) and resolves in microseconds — no I/O wait, no pool acquisition.
- Postgres `SELECT WHERE slug = ?` is O(log n) on a unique index but pays connection-pool acquisition + network round-trip + query planning + result serialization — typically 1–5 ms per call, and it consumes a connection from a bounded pool while it runs.

An attacker who can issue 10,000 requests/sec with random/garbage slugs would have generated ~30 connection-seconds of work per second consumed against the DB pool — quickly saturating the pool and queueing every legitimate ingest behind attacker traffic. Classic cheap-request / expensive-response amplification.

### 17.2 The Boundary

The `/ingest` site-validity check now distinguishes two failure modes:

| Outcome | Behavior | Cost ceiling |
|---|---|---|
| `SISMEMBER` returns 0 (cache miss — slug genuinely not in the set) | Reject with 404 immediately. **No DB query.** | Bounded by Redis. |
| `SISMEMBER` throws (Redis itself unavailable) | Fall through to a single DB `SELECT` as a circuit breaker. **No `SADD` re-warm attempt.** | DB. But this path only opens when Redis is degraded, which is itself a paging-worthy event. |

The circuit-breaker path deliberately does **not** attempt a `SADD` after the successful DB lookup. The function is only reachable because `SISMEMBER` errored, meaning Redis is unavailable; issuing a `SADD` in the same request would almost always fail too, adding a second wasted round-trip per request to a system that's already degraded. The rare race in which Redis recovers between the `SISMEMBER` and the `SADD` provides no real benefit either — once Redis is back, the next request's `SISMEMBER` resolves on the fast path on its own, because the boot-time warm and the per-create transactional `SADD` already keep the SET coherent. Cache re-population is the job of `BootstrapService` and `SitesService.create()`, not the fallback path.

The attacker who can only spray bogus slugs hits the first row forever — Redis takes the load, the database is untouched, legitimate ingests flow normally. To re-open the amplification surface they would have to take Redis down first, which is a much higher bar than slug-spraying.

### 17.3 The Coherence Invariant That Makes This Safe

Trusting the cache is only safe if the cache is always coherent with the database for every slug that exists. The system upholds this with **two coordinated guarantees**:

**1. Boot-time warming.** `BootstrapService.warmSitesCache()` runs after every module init and loads every row from `sites` into `sites:valid` via SADD. If the application restarts, the cache is rebuilt before any traffic is accepted.

**2. Transactional write coherence on creation.** `SitesService.create()` performs the DB INSERT and the SADD **inside one Drizzle transaction**. If the SADD throws (Redis is down), the transaction rolls back and the DB row is never persisted. There is no code path that produces a row in `sites` without a matching member in `sites:valid`.

```typescript
row = await this.db.db.transaction(async (tx) => {
  const rows = await tx.insert(sites).values({...}).returning();
  const inserted = rows[0];
  if (!inserted) throw new Error("INSERT returned no rows");

  // SADD must succeed for the tx to commit. Otherwise the DB INSERT
  // is rolled back, preserving cache-as-authority for /ingest.
  await this.redis.sadd(SITES_VALID_KEY, inserted.slug);
  return inserted;
});
```

The asymmetry is intentional and accepted: **site creation requires both DB and Redis to be healthy; measurement ingest only requires Redis to be healthy** (DB is touched only as a Redis-failure circuit breaker). Creation is rare and operator-initiated; ingest is the hot path. Different availability budgets are appropriate.

### 17.4 Failure Modes and Operational Consequences

| Scenario | Behavior | Recovery |
|---|---|---|
| Redis healthy, slug truly invalid | 404 immediately, no DB load | (Normal — the design's point) |
| Redis down, slug exists in DB | Circuit breaker engages: 1 DB query per request, ingest still works | Restore Redis |
| Redis down, slug doesn't exist in DB | 404 via circuit breaker | (Normal — the request was invalid anyway) |
| Redis loses the `sites:valid` SET (rare — see below) | All ingests 404 against the stale-empty cache until re-warm | Restart the API (re-triggers `BootstrapService.warmSitesCache`) |

The "Redis lost the set" scenario is improbable in our docker-compose config — `--appendonly yes` plus a named volume means restarts and crashes preserve the set within a 1-second AOF window. It can still happen via `FLUSHDB`, `pnpm infra:nuke`, or a future deploy on Redis without persistence. **If you change the Redis topology (managed Redis tier, ephemeral pod storage, etc.), revisit this assumption.**

### 17.5 What Was Considered and Rejected

- **Removing the DB fallback entirely** (cache-only, 503 on Redis failure). Cleaner cache-as-authority story, but means a Redis outage takes ingest offline. Rejected: the circuit-breaker DB path costs nothing in the normal case (Redis healthy) and keeps the system available during Redis degradation.
- **Treating `SADD` failure in `SitesService.create()` as non-fatal** (the previous implementation). Would let the DB and cache diverge: site exists in DB but cache says "not a member," so ingest rejects with 404. With the new cache-as-authority policy on the ingest side, this divergence becomes a real bug. Rejected: the transaction-with-SADD pattern is the correct fix.
- **Polling re-warm of the cache from the DB on a timer.** Self-healing for the "Redis lost the set" case. Rejected for this take-home: an "always-warm" assumption that silently re-warms hides infrastructure problems. Failing loudly (all ingests 404) is the more honest behavior.

---

## Architecture Decision Log

For detailed reasoning behind each decision, see `docs/PLAN.md`:
- **Entry 1.2–1.6:** Stack selection (NestJS, Next.js, Drizzle, Zod)
- **Entry 2.2–2.10:** Kafka + Redis edge-dedupe design
- **Entry 3.4–3.5:** Data model (sites, emission-points auto-create, partitioning, monthly aggregates)
- **Entry 4.2–4.6:** Carry-overs (TS-sources distribution, contracts schema, ARCHITECTURE.md authoring)
- **Entry 5.2:** Phase 2 implementation (response envelope, request-id, observability)

---

**Document Version:** Phase 5 complete (2026-05-18); §17 added 2026-05-19; §5 and §4.1 expanded 2026-05-19  
**Last Updated:** Added §5.2 — Kafka idempotent producer as the producer-side dedupe layer between Redis (Layer 1) and Postgres (Layer 3). Renumbered §5.2–§5.5 → §5.3–§5.6 and updated the one cross-ref. Expanded §4.1 with a dedicated "Why key by `site_slug`" subsection covering per-site serialization, emission-point contention avoidance, and the "10 concurrent writers" stress case.  
**Next Update:** Phase 6 (metrics endpoint + sites list) and Phase 7 (frontend dashboard).
