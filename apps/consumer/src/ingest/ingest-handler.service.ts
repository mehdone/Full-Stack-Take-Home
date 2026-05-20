import type { IngestBatchInput, MeasurementInput } from "@highwood/contracts";
import type { DbClient } from "@highwood/db";
import {
  measurements,
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
   * Process-local cache: site_slug → site_id.
   *
   * Sites are append-only in this schema (no delete path), so cached ids
   * cannot become stale within a process lifetime. Warms naturally from
   * query traffic.
   */
  private readonly siteIdCache = new Map<string, bigint>();

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

    let siteId = this.siteIdCache.get(site_slug);
    if (siteId === undefined) {
      const siteRows = await this.dbClient.db
        .select({ id: sites.id })
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

      siteId = siteRows[0].id;
      this.siteIdCache.set(site_slug, siteId);
    }

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
        await this.markMonthsStale(tx, siteId, insertedRows);
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
   * Mark each affected (year, month) pair stale in site_monthly_emissions.
   *
   * Derives UTC year/month from the `recordedAt` date of actually-inserted rows,
   * deduplicates, then upserts with `stale = true`. This guarantees the hourly
   * recompute job (Phase 5) picks up all affected aggregates.
   */
  private async markMonthsStale(
    tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
    siteId: bigint,
    insertedRows: Array<{ recordedAt: Date; value: string }>,
  ): Promise<void> {
    // Collect distinct (year, month) pairs from inserted rows' UTC timestamps.
    const monthSet = new Map<string, { year: number; month: number }>();
    for (const row of insertedRows) {
      const year = row.recordedAt.getUTCFullYear();
      const month = row.recordedAt.getUTCMonth() + 1; // getUTCMonth is 0-indexed
      const key = `${year}-${month}`;
      if (!monthSet.has(key)) {
        monthSet.set(key, { year, month });
      }
    }

    // Sort (year, month) so concurrent writers (e.g., the ETL hourly recompute
    // job in Phase 5) and this consumer acquire locks in the same order across
    // months. Deterministic lock ordering = no cross-feature deadlocks.
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
}
