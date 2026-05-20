/**
 * Test helpers for the idempotency suite.
 *
 * These helpers extend the base `test-app` helpers with:
 *   - Full-schema truncation (all six tables created by Phase-4 migrations).
 *   - Redis state reset (sites:valid set + ingest:dedupe:* hashes).
 *   - Test-only site creation that bypasses the HTTP edge for speed.
 *   - A Kafka "drain pump" that reads pending messages from the ingest topic
 *     and feeds them into `IngestHandlerService.handle()` directly — Option B
 *     from the concurrency-expert review (call services directly, bypass the
 *     long-running consumer process for determinism in tests).
 *
 * The drain pump uses a unique consumer group id per call so it never collides
 * with the production consumer group or with parallel test runs. We commit
 * offsets only after the DB tx returns, mirroring the production consumer.
 */

import { randomUUID } from "node:crypto";
import { type DbClient, sites as sitesTable } from "@highwood/db";
import { Logger } from "@nestjs/common";
import { type Admin, type Consumer, Kafka } from "kafkajs";
import { IngestHandlerService } from "../../../consumer/src/ingest/ingest-handler.service.ts";
import type { KafkaIngestMessage } from "../../../consumer/src/ingest/ingest-handler.service.ts";
import { SystemAlertsService } from "../../../consumer/src/system-alerts/system-alerts.service.ts";

const INGEST_TOPIC = process.env.INGEST_TOPIC ?? "emissions.ingest.v1";
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Truncate every table touched by the ingest pipeline. CASCADE handles FK
 * chains (sites -> emission points -> measurements / monthly aggregates).
 */
export async function truncateAllTables(dbClient: DbClient): Promise<void> {
  const tables = [
    "measurements",
    "site_monthly_emissions",
    "site_emission_points",
    "outbox",
    "system_alerts",
    "sites",
  ];

  for (const table of tables) {
    await dbClient.sql`TRUNCATE ${dbClient.sql(table)} RESTART IDENTITY CASCADE`;
  }
}

/**
 * Wipe Redis state that the ingest path depends on:
 *   - `sites:valid` SISMEMBER set (warmed by BootstrapService).
 *   - All `ingest:dedupe:*` hashes (the edge-dedupe records).
 *
 * Implementation note: we DEL specific keys rather than FLUSHDB so a test run
 * never wipes unrelated keys on a shared dev Redis.
 */
export async function flushRedisIngestState(redis: import("ioredis").Redis): Promise<void> {
  await redis.del("sites:valid");

  // Scan + delete all ingest dedupe hashes
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "ingest:dedupe:*", "COUNT", "200");
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}

/**
 * Insert a site row directly via Drizzle (faster than HTTP) and warm the
 * Redis sites:valid set so /ingest accepts the slug.
 */
export async function createTestSite(
  dbClient: DbClient,
  redis: import("ioredis").Redis,
  slug: string,
  overrides: Partial<{
    name: string;
    latitude: string;
    longitude: string;
    timezone: string;
    emissionLimit: string;
  }> = {},
): Promise<{ id: bigint; slug: string }> {
  const rows = await dbClient.db
    .insert(sitesTable)
    .values({
      slug,
      name: overrides.name ?? `Test Site ${slug}`,
      latitude: overrides.latitude ?? "51.500000",
      longitude: overrides.longitude ?? "-114.100000",
      timezone: overrides.timezone ?? "America/Edmonton",
      emissionLimit: overrides.emissionLimit ?? "10000.000000",
    })
    .returning({ id: sitesTable.id, slug: sitesTable.slug });

  if (!rows[0]) {
    throw new Error(`failed to insert test site '${slug}'`);
  }

  await redis.sadd("sites:valid", slug);
  return rows[0];
}

/**
 * Construct an in-process `IngestHandlerService` bound to the test DbClient.
 * Avoids the consumer NestJS bootstrap (Kafka consumer, system-alerts wiring)
 * by manually instantiating the two services the handler depends on.
 *
 * Returns the handler that test code can call with a parsed Kafka payload.
 */
export function buildIngestHandler(dbClient: DbClient): IngestHandlerService {
  const systemAlerts = new SystemAlertsService(dbClient);
  return new IngestHandlerService(dbClient, systemAlerts);
}

/**
 * Drain pump configuration. Each call uses a unique consumer group id so it
 * starts at the topic head (Kafka rebalances ignore stale offsets for a fresh
 * group) — that means we only see messages produced AFTER this consumer
 * subscribes. Tests must therefore start the pump BEFORE the POST that
 * produces, OR the pump must be configured with `fromBeginning: true` to
 * read every message ever produced to the topic. We use `fromBeginning: true`
 * combined with a unique group id so a clean run sees every message produced
 * during the test, regardless of timing.
 */
export interface DrainPump {
  /** Wait until at least `count` messages have been processed by the handler. */
  waitFor(count: number, timeoutMs?: number): Promise<KafkaIngestMessage[]>;
  /** Stop the pump and disconnect the consumer. */
  stop(): Promise<void>;
  /** Currently-processed messages (in offset order). */
  processed(): readonly KafkaIngestMessage[];
}

/**
 * Spin up a one-shot Kafka consumer that pulls messages from the ingest topic
 * and forwards each to `IngestHandlerService.handle()`. The handler runs the
 * full canonical DB transaction (inserts, outbox, stale-month flags) so the
 * test assertions on Postgres state are end-to-end faithful.
 *
 * The pump:
 *   - Uses `fromBeginning: true` + a unique groupId so it sees every message
 *     produced to the topic during the test (the topic is shared, but the
 *     test-data is keyed on the unique site slug each test creates).
 *   - Filters incoming messages by `site_slug` so a leaky test on a different
 *     slug does not pollute results.
 *   - Commits offsets only AFTER the handler resolves (autoCommit:false),
 *     mirroring production semantics.
 */
export async function startDrainPump(
  dbClient: DbClient,
  siteSlugFilter: string,
): Promise<DrainPump> {
  const handler = buildIngestHandler(dbClient);
  const groupId = `test-idempotency-${randomUUID()}`;
  const kafka = new Kafka({ clientId: groupId, brokers: KAFKA_BROKERS });
  const consumer: Consumer = kafka.consumer({ groupId });

  // Per-pump epoch: ignore Kafka messages with a `received_at_ms` older than
  // when this pump started. Without this, accumulated messages from earlier
  // test cases (same site slug, same topic) get replayed and pollute outbox
  // assertions. `fromBeginning: true` + per-test groupId means we WOULD see
  // every historical message; this epoch filter scopes us to "this pump's
  // window" only.
  const pumpStartedAtMs = BigInt(Date.now());

  const processed: KafkaIngestMessage[] = [];
  let stopped = false;
  // Logger to silence handler noise — handler.handle() uses a Nest Logger that
  // writes to console.log by default. Tests run with LOG_LEVEL=silent already.
  void new Logger("idempotency-pump");

  await consumer.connect();
  await consumer.subscribe({ topic: INGEST_TOPIC, fromBeginning: true });

  // Run the consumer in the background. We DO NOT await this promise — the
  // consumer.run() call resolves only when the consumer is stopped.
  void consumer.run({
    // autoCommit: true with a tight interval is required for KafkaJS to
    // actually persist offsets back to the broker. With autoCommit: false,
    // `commitOffsetsIfNecessary` is a no-op, KafkaJS can re-deliver messages
    // on session refresh, and the pump's `processed[]` array can double-count
    // a single produced message.
    autoCommit: true,
    autoCommitInterval: 100,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      for (const message of batch.messages) {
        if (stopped) return;
        if (!message.value) {
          resolveOffset(message.offset);
          continue;
        }
        let parsed: KafkaIngestMessage;
        try {
          parsed = JSON.parse(message.value.toString()) as KafkaIngestMessage;
        } catch {
          resolveOffset(message.offset);
          continue;
        }

        if (parsed.site_slug !== siteSlugFilter) {
          // Not ours — ack the offset and skip.
          resolveOffset(message.offset);
          continue;
        }

        // Stale message from a previous test case — ack and skip without
        // running the handler. `received_at_ms` is stamped by the producer at
        // HTTP request time.
        const receivedAtMs = BigInt(parsed.received_at_ms ?? 0);
        if (receivedAtMs < pumpStartedAtMs) {
          resolveOffset(message.offset);
          continue;
        }

        try {
          await handler.handle(parsed);
          processed.push(parsed);
        } catch (err) {
          // Surface handler failures so the test can assert on them.
          // We still resolve the offset so the consumer doesn't loop on
          // the bad message forever — tests rely on processed[] to detect
          // success / failure.
          // eslint-disable-next-line no-console
          console.error("[drain-pump] handler.handle failed:", err);
        }
        resolveOffset(message.offset);
        await heartbeat();
        await commitOffsetsIfNecessary();
      }
    },
  });

  const waitFor = async (count: number, timeoutMs = 15_000): Promise<KafkaIngestMessage[]> => {
    const start = Date.now();
    // Poll loop — yields the event loop so the in-flight `consumer.run()`
    // promise can make progress between checks.
    while (processed.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `drain pump timeout: expected ${count} messages for site '${siteSlugFilter}', got ${processed.length} after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [...processed];
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    try {
      await consumer.disconnect();
    } catch {
      // Disconnect can race with run() shutdown; safe to swallow.
    }
  };

  return {
    waitFor,
    stop,
    processed: () => processed,
  };
}

/**
 * Process messages that have ALREADY been produced to the topic without going
 * through Kafka — for tests that need to simulate the consumer replaying a
 * payload after a crash (`Test 2` Redis-bypass, `Test 6` partial-batch retry).
 *
 * Just calls the handler directly.
 */
export async function handleDirect(
  dbClient: DbClient,
  msg: KafkaIngestMessage,
): Promise<ReturnType<IngestHandlerService["handle"]>> {
  const handler = buildIngestHandler(dbClient);
  return handler.handle(msg);
}

/**
 * Clean up any topic state by waiting briefly for KafkaJS background tasks to
 * settle. KafkaJS warns about unhandled rejections if connections close mid-
 * heartbeat; calling this in `afterEach` keeps the log clean.
 */
export async function quiesceKafka(_brokers?: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Convenience: list current outbox rows in id order — the order they were
 * inserted, which matches consumer-processing order for a single-partition
 * site.
 */
export async function readOutbox(
  dbClient: DbClient,
): Promise<
  Array<{ id: bigint; event_type: string; aggregate_id: string; payload: Record<string, unknown> }>
> {
  const rows = await dbClient.sql<
    { id: bigint; event_type: string; aggregate_id: string; payload: Record<string, unknown> }[]
  >`SELECT id, event_type, aggregate_id, payload FROM outbox ORDER BY id ASC`;
  return rows.map((r) => ({ ...r }));
}

/**
 * Convenience: count measurements for a site_slug.
 */
export async function countMeasurementsForSlug(
  dbClient: DbClient,
  slug: string,
): Promise<{ count: number; sumKg: string }> {
  const rows = await dbClient.sql<{ count: string; sum_kg: string | null }[]>`
    SELECT COUNT(*)::text AS count, COALESCE(SUM(m.value), 0)::text AS sum_kg
    FROM measurements m
    JOIN sites s ON s.id = m.site_id
    WHERE s.slug = ${slug}
  `;
  const row = rows[0];
  if (!row) return { count: 0, sumKg: "0" };
  return { count: Number.parseInt(row.count, 10), sumKg: row.sum_kg ?? "0" };
}

/**
 * Make a deterministic measurement payload. All `recorded_at_ms` values are
 * stamped to land in the current-month partition.
 */
export function buildMeasurements(
  count: number,
  opts: { baseMillis?: number; spacingMs?: number; emissionPointPrefix?: string } = {},
): Array<{ emission_point: string; recorded_at_ms: number; value_kg_co2e: string }> {
  const base = opts.baseMillis ?? Date.now() - 60_000; // ~1 minute back
  const spacing = opts.spacingMs ?? 1_000; // 1 s apart
  const prefix = opts.emissionPointPrefix ?? "VENT";
  return Array.from({ length: count }, (_, i) => ({
    emission_point: `${prefix}-${(i % 3) + 1}`,
    recorded_at_ms: base + i * spacing,
    value_kg_co2e: ((i + 1) * 1.25).toFixed(6),
  }));
}

/**
 * Test-only: poke the dedupe hash to simulate Redis TTL expiry / manual bypass.
 */
export async function bypassRedisDedupe(
  redis: import("ioredis").Redis,
  siteSlug: string,
  batchId: string,
): Promise<void> {
  await redis.hdel(`ingest:dedupe:${siteSlug}`, batchId);
}

export { INGEST_TOPIC, KAFKA_BROKERS };
export type { Admin };
