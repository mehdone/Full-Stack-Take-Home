# Cache-as-Authority — Alternatives & Operational Detail

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §9.

## 1. Alternatives considered and rejected

### 1.1 Remove the DB fallback entirely (cache-only, 503 on Redis failure)

Cleaner story: Redis *is* the slug source of truth, full stop. If Redis is down, return `503` and let load balancers fail over.

**Rejected because** a Redis outage takes ingest offline. The circuit-breaker DB path costs nothing in the normal case (Redis healthy = no DB query) and keeps the system available during Redis degradation. The cost asymmetry doesn't switch directions just because Redis is down — a few thousand DB queries per second for the duration of a Redis outage is survivable; a complete ingest outage is not.

### 1.2 Treat `SADD` failure in `SitesService.create()` as non-fatal

The previous implementation did this — it created the site in Postgres and warned if the SADD failed. The argument was "we can recover via `BootstrapService.warmSitesCache` on next boot."

**Rejected because** with the new cache-as-authority policy on the ingest side, a divergence between DB ("site exists") and cache ("not a member") becomes a real bug: `/ingest` returns 404 for a site that absolutely exists. The transaction-with-SADD pattern (§9.3 in MEHDI.md) is the correct fix — a site that can't be advertised in Redis isn't useful and shouldn't be persisted.

### 1.3 Polling re-warm of the cache from the DB on a timer

Self-healing for the "Redis lost the set" case: e.g., every 5 minutes, `SELECT slug FROM sites` → `SADD sites:valid`.

**Rejected** because an always-warm assumption that silently re-warms hides infrastructure problems. The "Redis lost the set" scenario is improbable under docker-compose (`--appendonly yes` + named volume preserves the set within a 1-second AOF window). Failing loudly (all ingests 404 until the next boot warm) is the more honest behavior in this environment. A managed-Redis deployment would re-examine this.

### 1.4 Cache slug + emission-point list together

Eliminates the consumer's `INSERT … ON CONFLICT` for emission-point auto-creation by validating codes against a cached list at the API edge.

**Rejected because** emission points are auto-created on first sight by design — the API doesn't know which codes are valid for a site a priori. Pushing this knowledge to the edge would force operators to pre-declare emission points. The current process-cache-in-consumer pattern (§4.2 in MEHDI.md) is the right place for that hot-path data.

## 2. Failure modes

| Scenario | Behavior | Recovery |
|---|---|---|
| Redis healthy, slug truly invalid | 404 immediately, no DB load | (Normal — the design's point) |
| Redis down, slug exists in DB | Circuit breaker engages: 1 DB query per request, ingest still works | Restore Redis |
| Redis down, slug doesn't exist in DB | 404 via circuit breaker | (Normal — the request was invalid anyway) |
| Redis loses the `sites:valid` SET (rare — see below) | All ingests 404 against the stale-empty cache until re-warm | Restart the API (re-triggers `BootstrapService.warmSitesCache`) |

The "Redis lost the set" scenario is improbable in the docker-compose config — `--appendonly yes` plus a named volume preserves the set within a 1-second AOF window. It can still happen via:

- `FLUSHDB` (admin error)
- `pnpm infra:nuke` (intentional wipe)
- A future deploy on Redis without persistence
- Memory eviction policy (currently `noeviction` for the dedupe DB)

**If you change the Redis topology (managed Redis tier, ephemeral pod storage, etc.), revisit this assumption.**

## 3. The asymmetry to remember

| Operation | DB required? | Redis required? |
|---|---|---|
| `POST /sites` (operator-initiated, rare) | Yes | Yes |
| `POST /ingest` (hot path, public) | No (steady state) | Yes |
| Circuit-breaker `/ingest` path | Yes (one query) | No |
| `GET /sites/:slug/metrics` | Yes | No |

This is intentional. Creation has the budget for two-system availability; ingest does not. The circuit breaker is the safety valve that converts a Redis outage from "ingest offline" to "ingest degraded with elevated DB load."

## 4. Operational drills

A few exercises to verify the invariant holds:

1. **Stop Redis** while the API is running. Then:
   - `POST /ingest` for a known site → should succeed via the circuit-breaker DB path.
   - `POST /ingest` for an unknown slug → should `404` via the circuit-breaker DB path.
   - `POST /ingest` for a duplicate `batch_id` → may publish to Kafka anyway; Postgres unique index catches it. Confirm the outbox row carries `measurements_inserted: 0`.
2. **`SREM sites:valid <slug>`** for a real site while the API is running:
   - `POST /ingest` for that slug → `404` (cache says no; **this is the bug shape**).
   - Recovery: restart the API to re-run `BootstrapService.warmSitesCache`.
3. **`POST /sites`** while Redis is down:
   - Should return `500` with the slug **not** persisted in Postgres (transaction rolls back on SADD failure).
   - Verify with `SELECT * FROM sites WHERE slug = ?` after recovery.

These drills should each be a one-shot integration test in `apps/api/test/integration/` if hardened beyond the current scope.
