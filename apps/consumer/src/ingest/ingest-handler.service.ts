import type { IngestBatchInput, MeasurementInput } from "@highwood/contracts";
import type { DbClient } from "@highwood/db";
import {
  measurements,
  metricsOutbox,
  outbox,
  siteEmissionPoints,
  siteMonthlyEmissions,
  sites,
} from "@highwood/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DB_CLIENT } from "../db/db.tokens.ts";
import { SystemAlertsService } from "../system-alerts/system-alerts.service.ts";

/**
 * Result of processing one Kafka message.
 *
 * `shouldCommit` is always `true` for the cases we handle here — even on
 * "unknown site" we commit the offset (we wrote a system_alert and moved on).
 * It would only be false if we wanted to force a replay, but per spec we
 * prefer ack + system_alert over poison-pill blocking.
 */
export interface IngestResult {
  shouldCommit: boolean;
  inserted: number;
  duplicates: number;
  sumKg: string;
  siteId: bigint | null;
}

/** Shape of the JSON value the API producer sends to Kafka. */
export interface KafkaIngestMessage extends IngestBatchInput {
  received_at_ms: number;
}

/**
 * IngestHandlerService
 *
 * Wraps the full atomic persistence path for one ingest batch:
 *
 *   1. Look up site by slug (pre-tx; write system_alert + ack if missing).
 *   2. Resolve emission point code→id via process-local cache, falling back to
 *      a single batched SELECT, then INSERT … ON CONFLICT DO NOTHING RETURNING
 *      for genuinely-new codes, then a re-SELECT for the rare conflict-without-
 *      RETURNING race (pre-tx; cache warms across batches).
 *   3. BEGIN TX
 *        a. Bulk-insert measurements ON CONFLICT DO NOTHING RETURNING — count
 *           and sum only the actually-inserted rows.
 *        b. Mark affected (year, month) pairs stale in site_monthly_emissions.
 *        c. Write one outbox row per batch (even when inserted == 0).
 *      COMMIT
 *
 * Why resolve emission points outside the tx:
 *   - Emission-point rows are effectively append-only; the FK on measurements
 *     enforces validity at insert time, so reading the id outside the tx is
 *     safe.
 *   - Steady-state batches hit the cache → zero DB calls for resolution.
 *   - Cold/cache-miss batches do one batched SELECT instead of N speculative
 *     INSERTs, eliminating ON CONFLICT churn on the hot path.
 *   - The tx shrinks to only the writes that must commit atomically together
 *     (measurements + monthly stale flags + outbox), reducing lock-hold time.
 *
 * Concurrency design (no FOR UPDATE on site row):
 *   - All concurrent safety primitives are in the SQL:
 *     • INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING + re-SELECT
 *       fallback handles the rare cross-instance race on first-time
 *       emission-point creation (e.g. after a Kafka partition rebalance).
 *     • INSERT … ON CONFLICT (batch_id, emission_point_id, recorded_at) DO NOTHING
 *       handles measurement dedupe across concurrent batches.
 *     • INSERT … ON CONFLICT (site_id, year, month) DO UPDATE stale=true handles
 *       concurrent stale-flag writes for the same month.
 *
 * Kafka partitioning by site_slug serializes per-site traffic to one consumer
 * instance; concurrency across different sites is naturally safe. Per-site
 * concurrency (unlikely given per-partition delivery) is handled by the above.
 */
@Injectable()
export class IngestHandlerService {
  private readonly logger = new Logger(IngestHandlerService.name);

  /**
   * Process-local cache: site_slug → { id, timezone }.
   *
   * Sites are append-only in this schema (no delete path), so cached entries
   * cannot become stale within a process lifetime. Warms naturally from
   * query traffic. `timezone` is the site's IANA name, used for site-local
   * calendar bucketing in `markMonthsStale`.
   */
  private readonly siteIdCache = new Map<string, { id: bigint; timezone: string }>();

  /**
   * Process-local cache: `${siteId}:${code}` → emission_point_id.
   *
   * Emission points are append-only in this schema, so cached ids cannot become
   * stale within a process lifetime. The cache is rebuilt naturally from query
   * traffic after each restart; no explicit warmup needed.
   */
  private readonly emissionPointCache = new Map<string, bigint>();

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(SystemAlertsService) private readonly systemAlerts: SystemAlertsService,
  ) {}

  async handle(msg: KafkaIngestMessage): Promise<IngestResult> {
    const { batch_id, site_slug, measurements: inputMeasurements, received_at_ms } = msg;

    let cached = this.siteIdCache.get(site_slug);
    if (cached === undefined) {
      const siteRows = await this.dbClient.db
        .select({ id: sites.id, timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.slug, site_slug))
        .limit(1);

      if (siteRows.length === 0 || !siteRows[0]) {
        // Way too defensive programming; But we do so for the sake of data integrity and to be sleep well at night.
        this.logger.warn({
          event: "ingest.consumer.unknown_site",
          site_slug,
          batch_id,
          message: "site not found in consumer — edge validation gap",
        });
        await this.systemAlerts.insertAlert("unknown_site_in_consumer", {
          site_slug,
          batch_id,
        });
        return {
          shouldCommit: true,
          inserted: 0,
          duplicates: 0,
          sumKg: "0.000000",
          siteId: null,
        };
      }

      cached = { id: siteRows[0].id, timezone: siteRows[0].timezone };
      this.siteIdCache.set(site_slug, cached);
    }
    const siteId = cached.id;
    const siteTimezone = cached.timezone;

    // "Now" captured once per batch, in the site's local calendar. Used to skip
    // the stale-flag UPSERT for measurements that fall in the current site-local
    // month — those land in the live-SUM portion of `GET /metrics` and have no
    // cache row to invalidate yet.
    const nowYearMonth = siteLocalYearMonth(new Date(), siteTimezone);

    const emissionPointMap = await this.resolveEmissionPoints(siteId, inputMeasurements);

    // --- Tight tx: only writes that must commit atomically together ----------
    return this.dbClient.db.transaction(async (tx) => {
      const measurementRows = inputMeasurements.map((m) => {
        const epId = emissionPointMap.get(m.emission_point);
        if (epId === undefined) {
          // Should never happen: resolveEmissionPoints guarantees all codes are mapped.
          throw new Error(`emission point not resolved for code: ${m.emission_point}`);
        }
        return {
          siteId,
          emissionPointId: epId,
          batchId: batch_id,
          recordedAt: new Date(m.recorded_at_ms),
          value: m.value_kg_co2e,
        };
      });

      const insertedRows = await tx
        .insert(measurements)
        .values(measurementRows)
        .onConflictDoNothing()
        .returning({
          id: measurements.id,
          recordedAt: measurements.recordedAt,
          value: measurements.value,
        });

      const inserted = insertedRows.length;
      const duplicates = inputMeasurements.length - inserted;

      // Sum the values of actually-inserted rows only.
      const sumKg = insertedRows
        .reduce((acc, row) => acc + Number.parseFloat(row.value), 0)
        .toFixed(6);

      if (insertedRows.length > 0) {
        await this.markMonthsStale(tx, siteId, siteTimezone, nowYearMonth, insertedRows);
        await this.writeMetricsOutbox(tx, siteId, siteTimezone, insertedRows);
      }

      const persistedAtMs = Date.now();

      await tx.insert(outbox).values({
        eventType: "ingest.batch.persisted",
        aggregateId: site_slug,
        payload: {
          site_slug,
          batch_id,
          measurements_inserted: inserted,
          measurements_submitted: inputMeasurements.length,
          sum_kg_co2e: sumKg,
          received_at_ms,
          persisted_at_ms: persistedAtMs,
        },
      });

      this.logger.log({
        event: "ingest.batch.persisted",
        site_slug,
        batch_id,
        inserted,
        duplicates,
        sum_kg: sumKg,
      });

      return {
        shouldCommit: true,
        inserted,
        duplicates,
        sumKg,
        siteId,
      };
    });
  }

  private cacheKey(siteId: bigint, code: string): string {
    return `${siteId}:${code}`;
  }

  /**
   * Resolve emission point codes to database IDs using a tiered lookup:
   *
   *   1. Process-local cache (zero DB calls on warm hits — the steady-state).
   *   2. One batched SELECT … WHERE site_id=? AND code = ANY(?) for misses.
   *   3. One batched INSERT … ON CONFLICT (site_id, code) DO NOTHING RETURNING
   *      for codes still unresolved (genuinely-new emission points).
   *   4. One batched re-SELECT for the rare conflict-without-RETURNING race
   *      where another writer created the row between (2) and (3) — e.g.
   *      after a Kafka partition rebalance.
   *
   * Steady state: 0 DB calls. Cold batch: 1 call. New codes: 2 calls.
   * Cross-instance race: 3 calls. The previous per-code INSERT+SELECT pattern
   * paid speculative-insert cost on every code, every batch, even when the
   * row already existed.
   *
   * Called *outside* the measurement tx. Emission points are append-only and
   * the FK on measurements enforces validity at insert time, so the resolved
   * ids remain valid when the tx opens.
   */
  private async resolveEmissionPoints(
    siteId: bigint,
    inputMeasurements: MeasurementInput[],
  ): Promise<Map<string, bigint>> {
    const uniqueCodes = [...new Set(inputMeasurements.map((m) => m.emission_point))];
    const result = new Map<string, bigint>();
    const missing: string[] = [];

    // 1. Cache lookup.
    for (const code of uniqueCodes) {
      const cached = this.emissionPointCache.get(this.cacheKey(siteId, code));
      if (cached !== undefined) {
        result.set(code, cached);
      } else {
        missing.push(code);
      }
    }
    if (missing.length === 0) return result;

    const db = this.dbClient.db;

    // Batched SELECT for cache misses — one round-trip, not N.
    const existing = await db
      .select({ code: siteEmissionPoints.code, id: siteEmissionPoints.id })
      .from(siteEmissionPoints)
      .where(and(eq(siteEmissionPoints.siteId, siteId), inArray(siteEmissionPoints.code, missing)));

    const stillMissing = new Set(missing);
    for (const row of existing) {
      result.set(row.code, row.id);
      this.emissionPointCache.set(this.cacheKey(siteId, row.code), row.id);
      stillMissing.delete(row.code);
    }
    if (stillMissing.size === 0) return result;

    // Genuinely new codes. Sort for deterministic lock ordering
    const toCreate = [...stillMissing].sort().map((code) => ({ siteId, code }));
    const inserted = await db
      .insert(siteEmissionPoints)
      .values(toCreate)
      .onConflictDoNothing()
      .returning({ code: siteEmissionPoints.code, id: siteEmissionPoints.id });

    for (const row of inserted) {
      result.set(row.code, row.id);
      this.emissionPointCache.set(this.cacheKey(siteId, row.code), row.id);
      stillMissing.delete(row.code);
    }
    return result;
  }

  /**
   * Mark each affected past (year, month) pair stale in site_monthly_emissions.
   *
   * Year/month are derived in the **site's local calendar** (IANA timezone),
   * not UTC — the cache row represents a local calendar month for regulatory
   * reporting. The current site-local month is **skipped**: it has no cache
   * row yet (the ETL creates it on month close), and `GET /metrics` reads the
   * current month live from `measurements`, so flagging it would be wasted
   * write amplification.
   *
   * Only measurements whose site-local (year, month) is strictly less than
   * `nowYearMonth` produce an UPSERT. The remaining set is sorted so concurrent
   * writers (e.g. a future ETL recompute job) acquire month-row locks in the
   * same order — deterministic lock ordering = no cross-feature deadlocks.
   */
  private async markMonthsStale(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    siteId: bigint,
    siteTimezone: string,
    nowYearMonth: { year: number; month: number },
    insertedRows: Array<{ recordedAt: Date; value: string }>,
  ): Promise<void> {
    // Collect distinct site-local (year, month) pairs, keeping only those that
    // are strictly past relative to the site's local "now."
    const monthSet = new Map<string, { year: number; month: number }>();
    for (const row of insertedRows) {
      const { year, month } = siteLocalYearMonth(row.recordedAt, siteTimezone);
      if (!isStrictlyBefore({ year, month }, nowYearMonth)) continue;
      const key = `${year}-${month}`;
      if (!monthSet.has(key)) {
        monthSet.set(key, { year, month });
      }
    }
    if (monthSet.size === 0) return;

    const orderedMonths = [...monthSet.values()].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );

    for (const { year, month } of orderedMonths) {
      await tx
        .insert(siteMonthlyEmissions)
        .values({
          siteId,
          year,
          month,
          totalKg: "0",
          stale: true,
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            siteMonthlyEmissions.siteId,
            siteMonthlyEmissions.year,
            siteMonthlyEmissions.month,
          ],
          set: { stale: sql`true` },
        });
    }
  }

  /**
   * Write one `metrics_outbox` row per distinct site-local (year, month) in the
   * just-inserted rows. The delta is the sum of `value` for the rows in that
   * month. The metrics-relay picks these up and applies HINCRBYFLOAT to a
   * per-site Redis hash via a SETNX-guarded Lua script (exactly-once
   * application under at-least-once relay delivery).
   *
   * No filtering by past/current month here: the proposal explicitly accepts
   * writing past-month fields too. Past-month fields land in the hash
   * harmlessly — the read path only consults the current month, but
   * suppressing past-month writes would add per-row branching for no benefit.
   *
   * Numeric precision: deltas are summed with `Number` and serialized back via
   * `toFixed(6)` to match `numeric(18, 6)`. The relay's HINCRBYFLOAT is itself
   * IEEE-754; total drift across a month is sub-picogram for realistic
   * emissions ranges. See docs/architecture/metrics-cache.md §5 for the
   * precision analysis.
   */
  private async writeMetricsOutbox(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    siteId: bigint,
    siteTimezone: string,
    insertedRows: Array<{ recordedAt: Date; value: string }>,
  ): Promise<void> {
    // Sum values by site-local (year, month).
    const sums = new Map<string, { year: number; month: number; total: number }>();
    for (const row of insertedRows) {
      const { year, month } = siteLocalYearMonth(row.recordedAt, siteTimezone);
      const key = `${year}-${month}`;
      const existing = sums.get(key);
      const v = Number.parseFloat(row.value);
      if (existing) {
        existing.total += v;
      } else {
        sums.set(key, { year, month, total: v });
      }
    }
    if (sums.size === 0) return;

    // Deterministic order keeps lock-acquisition consistent under concurrent
    // writers (paranoid; this is an INSERT-only table with a FK to sites).
    const rows = [...sums.values()]
      .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month))
      .map(({ year, month, total }) => ({
        siteId,
        year,
        month,
        deltaKg: total.toFixed(6),
      }));

    await tx.insert(metricsOutbox).values(rows);
  }
}

/**
 * Convert a UTC `Date` instant to a `{ year, month }` pair in an IANA timezone.
 * Uses Node's built-in `Intl.DateTimeFormat` — no external dep.
 */
function siteLocalYearMonth(instant: Date, timezone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month };
}

function isStrictlyBefore(
  a: { year: number; month: number },
  b: { year: number; month: number },
): boolean {
  return a.year !== b.year ? a.year < b.year : a.month < b.month;
}
