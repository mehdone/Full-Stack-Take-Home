import type { IngestAccepted, IngestBatchInput } from "@highwood/contracts";
import type { DbClient } from "@highwood/db";
import { sites } from "@highwood/db";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Producer } from "kafkajs";
import { SITES_VALID_KEY } from "../bootstrap/bootstrap.service.ts";
import { AppConfigService } from "../config/app-config.service.ts";
import { DB_CLIENT } from "../db/db.tokens.ts";
import { KAFKA_PRODUCER } from "../kafka/kafka.tokens.ts";
import { REDIS_CLIENT } from "../redis/redis.tokens.ts";

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async ingest(batch: IngestBatchInput): Promise<IngestAccepted> {
    const { batch_id, site_slug, measurements } = batch;

    // ------------------------------------------------------------------
    // 1. Site validity check — Redis SISMEMBER with DB fallback
    // ------------------------------------------------------------------
    await this.assertSiteValid(site_slug);

    // ------------------------------------------------------------------
    // 2. Batch dedupe — Lua HSETNX + HEXPIRE
    // ------------------------------------------------------------------
    const dedupeKey = `ingest:dedupe:${site_slug}`;
    const ttl = this.config.batchDedupeTtlSeconds;
    let isFirstSight: boolean;

    try {
      // Returns 1 (first time) or 0 (duplicate)
      const result = await this.redis.batchDedupe(dedupeKey, batch_id, ttl);
      isFirstSight = result === 1;
    } catch (err) {
      // Redis dedupe failure — log and treat as first-sight so we don't
      // silently drop data. The Postgres unique index is the authoritative guard.
      this.logger.warn({
        event: "ingest.dedupe.redis_error",
        batch_id,
        site_slug,
        error: err instanceof Error ? err.message : String(err),
        message: "Redis dedupe failed; proceeding without edge dedupe",
      });
      isFirstSight = true;
    }

    if (!isFirstSight) {
      this.logger.log({
        event: "ingest.batch.duplicate",
        batch_id,
        site_slug,
        measurements_received: measurements.length,
      });
      // Return 202 — duplicate is a no-op success, not a 409.
      // The client's retry worked correctly.
      return {
        batch_id,
        status: "queued",
        measurements_received: measurements.length,
      };
    }

    // ------------------------------------------------------------------
    // 3. Produce to Kafka
    // ------------------------------------------------------------------
    const receivedAtMs = Date.now();

    try {
      await this.producer.send({
        topic: this.config.ingestTopic,
        messages: [
          {
            // Key by site_slug: all messages for one site land on the same partition,
            // preserving per-site ordering for the consumer's FOR UPDATE locking.
            key: site_slug,
            value: JSON.stringify({ ...batch, received_at_ms: receivedAtMs }),
          },
        ],
      });
    } catch (err) {
      // Revert the dedupe entry so the client can retry without being shadow-blocked.
      await this.revertDedupe(dedupeKey, batch_id);

      this.logger.error({
        event: "ingest.batch.produce_failed",
        batch_id,
        site_slug,
        error: err instanceof Error ? err.message : String(err),
      });

      // Re-throw as an unhandled error — AllExceptionsFilter maps it to INTERNAL 500.
      throw err;
    }

    this.logger.log({
      event: "ingest.batch.accepted",
      batch_id,
      site_slug,
      count: measurements.length,
    });

    return {
      batch_id,
      status: "queued",
      measurements_received: measurements.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Assert the site slug is valid.
   *
   * Cache-as-authority on the hot path: the Redis `sites:valid` SET is the
   * sole source of truth in steady state. A cache miss returns 404 immediately
   * — we do NOT fall back to the DB just because the slug isn't in the set.
   *
   * Why: this is a DOS-protection boundary. An attacker spraying `/ingest`
   * with random slugs would otherwise amplify each request into a DB lookup
   * (~3ms, with connection-pool contention) instead of a Redis SISMEMBER
   * (~microseconds). Cache-only validation keeps the amplification surface
   * at Redis, never the database. See ARCHITECTURE.md §14.
   *
   * Cache coherence is upheld by `SitesService.create()` which performs the
   * DB insert and the SADD in one transaction (the SADD must succeed for
   * the site to exist), and by `BootstrapService` warming the set from the
   * DB on every app boot.
   *
   * Circuit breaker — Redis itself unavailable:
   * If `SISMEMBER` throws (not "returned 0", but actually errored — Redis
   * down, connection reset, etc.), we fall through to a DB lookup so
   * legitimate traffic survives a Redis outage. This preserves the DOS
   * guarantee in the normal case (Redis healthy → no DB amplification)
   * while keeping ingest available during Redis degradation. An attacker
   * who can take Redis down opens this surface back up, but that requires
   * compromising Redis, a much higher bar than slug-spraying.
   */
  private async assertSiteValid(siteSlug: string): Promise<void> {
    let isMember: boolean;

    try {
      isMember = (await this.redis.sismember(SITES_VALID_KEY, siteSlug)) === 1;
    } catch (err) {
      // Redis itself failed (NOT a cache miss). Engage the DB circuit breaker.
      this.logger.warn({
        event: "ingest.site_check.redis_error",
        site_slug: siteSlug,
        error: err instanceof Error ? err.message : String(err),
        message: "Redis SISMEMBER failed; falling back to DB lookup",
      });
      return this.assertSiteValidViaDb(siteSlug);
    }

    if (isMember) {
      return;
    }

    // Cache hit, slug not in set. Trust the cache: reject without touching
    // the DB. This is the DOS-protection boundary — bogus slugs cost only
    // a Redis round-trip, never a database query.
    throw new NotFoundException({
      message: `site with slug '${siteSlug}' not found`,
      details: { site_slug: siteSlug },
    });
  }

  /**
   * Circuit-breaker path: only invoked when Redis is unavailable, never on a
   * legitimate cache miss. See `assertSiteValid` for the rationale.
   */
  private async assertSiteValidViaDb(siteSlug: string): Promise<void> {
    const rows = await this.dbClient.db
      .select({ slug: sites.slug })
      .from(sites)
      .where(eq(sites.slug, siteSlug))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException({
        message: `site with slug '${siteSlug}' not found`,
        details: { site_slug: siteSlug },
      });
    }
  }

  /**
   * Revert a dedupe entry after a Kafka produce failure so the client's
   * next retry is not shadow-blocked by a stale "already seen" record.
   */
  private async revertDedupe(dedupeKey: string, batchId: string): Promise<void> {
    try {
      await this.redis.hdel(dedupeKey, batchId);
      this.logger.log({
        event: "ingest.dedupe.reverted",
        dedupeKey,
        batchId,
      });
    } catch (err) {
      this.logger.warn({
        event: "ingest.dedupe.revert_failed",
        dedupeKey,
        batchId,
        error: err instanceof Error ? err.message : String(err),
        message: "Could not revert dedupe entry; next retry may be treated as duplicate",
      });
    }
  }
}
