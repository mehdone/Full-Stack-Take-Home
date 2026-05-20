# Metrics Cache — Redis Pre-Aggregated Sums

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document is a deep-dive on the Redis cache that lets `GET /sites/:slug/metrics` answer the current-month component without scanning `measurements`.

## 1. What it is

A per-site Redis hash, one field per site-local `(year, month)`, value = pre-aggregated kg CO₂e for that month.

```
HASH key         field    value
metrics:<site_id> 202604   1240.500000    -- Apr 2026, site-local
metrics:<site_id> 202605   312.900000     -- May 2026, site-local (current month)
```

Each field carries a TTL via `HEXPIRE` (90 days default), so historical fields self-prune.

`GET /metrics`'s computation becomes:

```
total = SUM(site_monthly_emissions WHERE year/month < current_site_local_month AND stale = FALSE)
      + COALESCE(HGET metrics:<site_id> <current_yyyymm>, 0)
```

Postgres remains the source of truth for closed months (via the ETL); Redis is the live cache for the current month.

## 2. Why this design

Without the cache, the current-month component is a partition scan of `measurements`:

```sql
SELECT COALESCE(SUM(value), 0) FROM measurements
 WHERE site_id = ? AND recorded_at >= start_of_current_site_local_month;
```

The cost grows monotonically through the month. On day 30, a site producing 10k readings/day costs a ~300k-row scan per read. With the cache it's `HGET` — O(1) regardless of how full the month is.

The cache is **derived** from Postgres. The relay is the bridge.

## 3. End-to-end flow

```
Consumer transaction
┌────────────────────────────────────────────────────────────────────┐
│ BEGIN                                                              │
│   INSERT measurements ON CONFLICT DO NOTHING RETURNING …           │
│   UPSERT site_monthly_emissions stale=TRUE  -- past months only    │
│   INSERT outbox                                                    │
│   INSERT metrics_outbox  -- one row per (site, year, month) in     │
│                             this batch, delta = sum of values      │
│ COMMIT                                                             │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (asynchronously)
┌────────────────────────────────────────────────────────────────────┐
│ Metrics-relay tick                                                 │
│   SELECT … FROM metrics_outbox FOR UPDATE SKIP LOCKED              │
│   For each row: EVAL Lua (SETNX guard + HINCRBYFLOAT + HEXPIRE)    │
│   UPDATE delivered_at = now() in same TX                           │
│   On error: backoff + attempts++; on exhaustion: system_alerts     │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ GET /metrics                                                       │
│   SUM(site_monthly_emissions for past site-local months)           │
│   + HGET metrics:<site_id> <current_yyyymm>  (NULL → 0)            │
│   On Redis down: fall back to live SUM of current month            │
└────────────────────────────────────────────────────────────────────┘
```

## 4. Postgres ↔ Redis divergence — why the outbox

`HINCRBYFLOAT` is not transactional with Postgres. The three naive sequencings each have a window:

| Sequencing | Failure mode |
|---|---|
| `HINCRBYFLOAT` before `COMMIT` | `COMMIT` fails → Redis already incremented → **overcount, permanent drift** |
| `HINCRBYFLOAT` after `COMMIT` | Process dies between → measurements persisted, Redis never updated → Kafka redeliver, unique-index dedupes the measurements (`inserted = 0`), HINCRBYFLOAT is skipped this time too → **undercount, permanent drift** |
| Inside one TX | Not a thing; Redis isn't in the Postgres transaction |

The outbox pattern bounds the window. The `metrics_outbox` row is written in the same TX as the measurements:

- If the consumer commits, the row exists → the relay will eventually apply.
- If the consumer doesn't commit, the row doesn't exist → no spurious increment.

Combined with the SETNX-guarded Lua (next section), the relay achieves **exactly-once application of the increment** under at-least-once relay delivery.

## 5. The SETNX-guarded Lua script

```lua
-- KEYS[1] = applied:metrics_outbox:<outbox_id>     idempotency guard
-- KEYS[2] = metrics:<site_id>                      per-site hash
-- ARGV[1] = <yyyymm>                               site-local year/month
-- ARGV[2] = <delta_kg>                             value to add (string)
-- ARGV[3] = <applied_ttl_seconds>                  TTL on guard key
-- ARGV[4] = <field_ttl_seconds>                    HEXPIRE on hash field

local applied = redis.call("SETNX", KEYS[1], "1")
if applied == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[3])
  redis.call("HINCRBYFLOAT", KEYS[2], ARGV[1], ARGV[2])
  redis.call("HEXPIRE", KEYS[2], ARGV[4], "FIELDS", 1, ARGV[1])
  return 1
else
  return 0
end
```

Why this is needed: `HINCRBYFLOAT` is not idempotent. The relay's `SELECT FOR UPDATE SKIP LOCKED → do work → UPDATE delivered_at` pattern prevents two replicas from racing on the same row, but does **not** cover the crash window between the Redis call and the SQL `UPDATE`. On restart, the outbox row looks undelivered, the relay would call HINCRBYFLOAT again, and the value would drift.

The `applied:metrics_outbox:<id>` key acts as a per-row token. On re-application, `SETNX` returns 0 and the HINCRBYFLOAT is skipped. The relay still issues the `UPDATE delivered_at` afterwards (now consistent with reality), and the row is closed.

TTL on the guard key only needs to outlive the worst-case retry window of its outbox row. With defaults (`MAX_ATTEMPTS=10`, `BACKOFF_CAP_SECONDS=300`), worst case is ~14 minutes. **7 days** is the default — generous slack against operator-unfreeze scenarios.

TTL on the hash field is **90 days** by default — a closed month's row in Redis is reachable for ~3 months after the month ends, well after the ETL has closed it in Postgres. If a `GET /metrics` consults Redis for a closed month by mistake, it gets a stale answer; but the read path only ever looks at the current month, so this never happens in practice.

## 6. Precision

`HINCRBYFLOAT` uses 80-bit long double internally on x86_64 (≈18 significant decimal digits). Realistic scenario for one site-month:

- ~3,000 HINCRBYFLOAT calls per month (one per accepted batch, ~100 batches/day × 30 days).
- Monthly totals in the 10⁴–10⁵ kg range.
- Accumulated error: √3,000 × 10⁻¹⁸ × 10⁵ ≈ **5 × 10⁻¹² kg = 5 picograms**.

This is physically meaningless for environmental kg CO₂e — well below the `numeric(18, 6)` sensor precision (microgram).

The reason precision *could* matter is **bit-exact agreement with Postgres `numeric(18, 6)`**. Postgres `numeric` is arbitrary-precision decimal — exact. `HINCRBYFLOAT` in Redis is approximate. If a regulator-facing report read the Redis number, you'd want exactness — and the workaround is scaled-integer storage: `value × 10⁶` as an int64, `HINCRBY` instead of `HINCRBYFLOAT`. Range allowed: ±9.2 × 10¹² kg per site-month, well above physical reality.

In this system, Redis is only consulted for the **current** month. Canonical historical numbers come from the ETL via Postgres. Precision drift in the current-month live read is invisible to the user. So `HINCRBYFLOAT` it is.

If a future use case ever needs bit-exact Redis values, switch to scaled-integer; the schema and relay shape don't change.

## 7. Late arrivals — past-month writes are harmless

A batch can contain readings whose site-local `(year, month)` is in the past (e.g. a device with intermittent connectivity dumping yesterday's readings today). The consumer doesn't filter these out of the metrics_outbox — the relay applies HINCRBYFLOAT to whatever month-field the row specifies.

This means the Redis hash may carry past-month fields. The read path doesn't consult them (only the current month is queried). They sit there, harmless, until their 90-day HEXPIRE fires.

The alternative — filtering past-month writes out of `metrics_outbox` — would add per-row branching for no observable benefit. We accept the dead writes.

## 8. Cold start / warm start

The first deploy of this system, or any cold restart with an empty Redis: the hash is missing for every site. The metrics endpoint must treat **missing field as 0**:

```ts
const microkgOrKgString = await redis.hget(`metrics:${siteId}`, yyyymm);
const currentMonthKg = microkgOrKgString ? Number.parseFloat(microkgOrKgString) : 0;
```

This is correct only if the cache has been kept coherent since day 1. If you deploy this change after measurements already exist in Postgres, **the current month will undercount until a manual reconciliation** is run (e.g. a one-shot script that SUMs measurements per (site, current site-local month) and `HSET`s the result).

For a greenfield deploy, no reconciliation is needed — every measurement that hits Postgres also writes a `metrics_outbox` row, so Redis is correct from the first batch onward.

## 9. Redis-down fallback

If Redis is down at read time, `GET /metrics` falls back to a live SUM of `measurements` for the current site-local month. The fallback is slower but correct, and degrades gracefully. Same circuit-breaker shape as the `/ingest` cache-as-authority boundary in `cache-as-authority.md`.

The metrics-relay handles a Redis outage via the standard backoff/attempts mechanism on the outbox row — increments queue up in `metrics_outbox` and are applied as soon as Redis recovers.

## 10. Operational drills

A few exercises to validate the invariant holds:

1. **Stop Redis** while the consumer is ingesting. Send a batch.
   - The metrics_outbox row should be written normally.
   - The metrics-relay should retry with backoff and not deliver.
   - When Redis comes back, the next tick should apply the increment and mark `delivered_at`.

2. **Kill the metrics-relay** between `HINCRBYFLOAT` and `UPDATE delivered_at` (use a debugger / breakpoint). On restart:
   - The relay picks the row up again.
   - `SETNX` on the `applied:metrics_outbox:<id>` guard returns 0.
   - HINCRBYFLOAT is **not** repeated.
   - The relay still issues the `UPDATE delivered_at`, closing the row.

3. **Compare totals.** After a batch is fully drained, `HGET metrics:<site_id> <yyyymm>` should equal `SUM(measurements.value WHERE site_id = ? AND site_local_(year, month) = (?, ?))` within float precision (sub-picogram for any realistic batch volume).

These should each be a one-shot integration test if hardened beyond the current scope.

## 11. Future: when to revisit

- **Bit-exact Redis values needed** (e.g. for direct export to a regulator): switch to scaled-integer + `HINCRBY`. Mechanical change.
- **Multi-region Redis**: the relay would need to fan out to multiple Redis instances or rely on Redis replication. The outbox pattern stays the same.
- **Per-field write rate too high to apply individually**: the relay can coalesce in-flight rows by `(site_id, year, month)` before issuing the Lua call — the SETNX guard tokens become per-batch instead of per-row. Out of scope for now.
