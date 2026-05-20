# `POST /ingest` — Full Pipeline Walkthrough

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §4.2.

## 1. Happy path, end to end

```
Client                  API                Redis            Kafka         Consumer        Postgres
  │                      │                   │                │              │                │
  │── POST /ingest ─────▶│                   │                │              │                │
  │   { batch_id,        │                   │                │              │                │
  │     site_slug,       │                   │                │              │                │
  │     measurements }   │                   │                │              │                │
  │                      │── SISMEMBER ─────▶│                │              │                │
  │                      │    sites:valid    │                │              │                │
  │                      │◀── 1 ─────────────│                │              │                │
  │                      │                   │                │              │                │
  │                      │── HSETNX +        │                │              │                │
  │                      │    HEXPIRE (Lua)─▶│                │              │                │
  │                      │◀── 1 (first sight)│                │              │                │
  │                      │                   │                │              │                │
  │                      │── produce ────────────────────────▶│              │                │
  │                      │    key=site_slug, value={batch}    │              │                │
  │                      │◀── ack ────────────────────────────│              │                │
  │                      │                   │                │              │                │
  │◀── 202 ──────────────│                   │                │              │                │
  │   { batch_id,        │                   │                │              │                │
  │     status: queued } │                   │                │              │                │
  │                      │                   │                │              │                │
  │                      │                   │                │── consume ──▶│                │
  │                      │                   │                │              │                │
  │                      │                   │                │              │── BEGIN ──────▶│
  │                      │                   │                │              │── INSERT       │
  │                      │                   │                │              │   measurements │
  │                      │                   │                │              │   ON CONFLICT  │
  │                      │                   │                │              │   DO NOTHING ─▶│
  │                      │                   │                │              │── UPSERT       │
  │                      │                   │                │              │   monthly_     │
  │                      │                   │                │              │   emissions ──▶│
  │                      │                   │                │              │   (past months │
  │                      │                   │                │              │    only; site- │
  │                      │                   │                │              │    local time) │
  │                      │                   │                │              │── INSERT       │
  │                      │                   │                │              │   outbox ─────▶│
  │                      │                   │                │              │── COMMIT ─────▶│
  │                      │                   │                │◀── commit ───│                │
  │                      │                   │                │   offset     │                │
```

## 2. Edge cases (the interesting branches)

### 2.1 Duplicate `batch_id` from a retrying client

```
SISMEMBER sites:valid <slug>     → 1
HSETNX dedupe:<slug> <batch>     → 0  (already there)
```

API short-circuits: `202 { batch_id, status: "queued", stale: true }`. No Kafka message. No DB touch. The client receives the same response shape as the original successful submit, but with `stale: true` so it knows it's a deduped retry.

### 2.2 Unknown slug

```
SISMEMBER sites:valid <slug>     → 0
```

API returns `404 { ok: false, error: { code: "NOT_FOUND", ... } }`. **No DB query.** This is the cache-as-authority boundary (§9 in MEHDI.md).

### 2.3 Redis down (`SISMEMBER` throws)

Circuit breaker: API falls through to a single `SELECT id FROM sites WHERE slug = ?`. If found, proceed (without dedupe — the next layer catches duplicates). If not found, `404`. **No `SADD` re-warm attempt** — Redis is presumed unhealthy.

The dedupe layer is also lost during this window, so duplicates from a retrying client during a Redis outage will reach Kafka and be caught by:
1. The Kafka idempotent producer (if same in-flight retry).
2. The Postgres unique index (authoritative).

### 2.4 Kafka produce timeout

KafkaJS retries up to `retry: { retries: 5 }`. With `idempotent: true` + `maxInFlightRequests: 1`, the broker tracks per-producer-partition sequence numbers and rejects duplicates. If all retries exhaust, the API returns `500 INTERNAL`; the client should retry — Redis already holds the `batch_id`, so the retry path is:

- Redis HSETNX returns 0 → API returns `202 stale: true` even though the original never made it to Kafka.

This is the **consumer-permanent-failure-lockout cousin**: the client thinks the batch was accepted when it wasn't. Mitigation: short TTL on dedupe entries or explicit clear-on-failure (deferred — §6.6 in MEHDI.md).

### 2.5 Consumer crash between DB commit and Kafka offset commit

Postgres has the measurements + outbox row. Kafka still thinks the message is unconsumed. On consumer restart:

```
Re-consume the same message
  → INSERT measurements ON CONFLICT DO NOTHING returns 0 rows
  → UPSERT monthly_emissions sets stale=TRUE (idempotent)
  → INSERT outbox row with measurements_inserted: 0  ← second row for same batch_id
COMMIT
Commit Kafka offset
```

The outbox carries two rows for this `batch_id`. The relay → alerting receiver dedupes on `batch_id` and suppresses the no-op row (§6.5, §10.4 in MEHDI.md).

### 2.6 Late arrival into a closed month

The consumer derives each measurement's `(year, month)` in the site's IANA timezone. If that pair is strictly before the site's current local `(year, month)`, the `INSERT site_monthly_emissions ... ON CONFLICT DO UPDATE SET stale = TRUE` fires and flips the affected month's row to `stale = TRUE`. The hourly recompute job (or the next `GET /metrics` request that touches the row) recomputes the total.

Current-site-local-month measurements **do not** trigger the UPSERT — the current month has no cache row to invalidate (the ETL creates it on month close) and `GET /metrics` reads the current month live from `measurements`. Skipping the no-op write removes WAL exhaustion on the steady-state hot path.

This is what makes monthly aggregates safe under out-of-order arrivals while keeping the steady-state path cheap — see §5.3 in MEHDI.md for the worked example.

### 2.7 Clock-skew rejection

Pre-transaction check: if any `recorded_at` is more than 5 minutes ahead of the site's local now (computed against the site's IANA timezone), the batch is rejected `4xx` and a `system_alerts` row is written. The site's timezone is read from `sites.timezone`.

This is enforced **at the consumer**, after Kafka. The API does not have site timezone in hand without a DB read, so the rejection happens at ingest-time on the consumer side. The relay propagates the alert; ops investigates the misconfigured device.

## 3. Emission-point resolution detail

Resolved **outside** the transaction (the FK on `measurements` ensures validity at insert time, so reading earlier is safe and keeps the TX short):

```
1. For each (site_id, code) in the batch:
   - Hit process-local Map<"siteId:code", id>. Steady state: 100% hit, 0 DB calls.

2. For misses (cold batch, new instance, or just unseen code):
   - One batched SELECT WHERE site_id = ? AND code = ANY(missing_codes).

3. For codes still missing (genuinely new):
   - Sort lexicographically (deterministic lock ordering).
   - One batched INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING.

4. For codes that the INSERT didn't RETURN (lost the race to a sibling consumer
   during a Kafka partition rebalance):
   - One batched re-SELECT.

5. Populate the process-local cache with all resolved ids for next batch.
```

In steady state (warm cache), step 1 returns all ids and steps 2–4 are skipped entirely.

## 4. What the API actually returns

Always one of:

```jsonc
// First sight
202 { "ok": true, "data": { "batch_id": "...", "status": "queued", "stale": false } }

// Duplicate retry (Redis caught it)
202 { "ok": true, "data": { "batch_id": "...", "status": "queued", "stale": true } }

// Unknown slug
404 { "ok": false, "error": { "code": "NOT_FOUND", ... } }

// Validation failure
400 { "ok": false, "error": { "code": "VALIDATION_FAILED", ... } }

// Kafka unavailable, retries exhausted
500 { "ok": false, "error": { "code": "INTERNAL", "request_id": "..." } }
```

The 202 + `stale: false` / `stale: true` contract is what enables the dashboard's retry UX: the front-end submits the same `batch_id` again; if it ever gets a 202 (even with `stale: true`), the retry is considered successful.
