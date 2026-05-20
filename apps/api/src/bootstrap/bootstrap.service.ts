import type { DbClient } from "@highwood/db";
import { sites } from "@highwood/db";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DB_CLIENT } from "../db/db.tokens.ts";
import { REDIS_CLIENT } from "../redis/redis.tokens.ts";

export const SITES_VALID_KEY = "sites:valid";

/**
 * BootstrapService runs after all modules initialise (Nest guarantees
 * onModuleInit order respects the dependency graph). It warms the Redis
 * `sites:valid` SET from Postgres so `/ingest` can use O(1) SISMEMBER
 * lookups without hitting the DB on the hot path.
 *
 * If Redis is down at boot, we log a warning and continue — `/ingest` will
 * fall back to the DB lookup path. The app is still useful without cache.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.warmSitesCache();
  }

  async warmSitesCache(): Promise<void> {
    try {
      const allSites = await this.dbClient.db.select({ slug: sites.slug }).from(sites);

      if (allSites.length === 0) {
        this.logger.log({ event: "bootstrap.sites_cache.empty", message: "no sites in DB yet" });
        return;
      }

      const slugs = allSites.map((s) => s.slug);
      // SADD is idempotent — adding existing members is a no-op
      await this.redis.sadd(SITES_VALID_KEY, ...slugs);

      this.logger.log({
        event: "bootstrap.sites_cache.warmed",
        count: slugs.length,
        message: `warmed ${slugs.length} site slug(s) into Redis sites:valid`,
      });
    } catch (err) {
      // Redis failure is non-fatal — /ingest falls back to the DB lookup path
      this.logger.warn({
        event: "bootstrap.sites_cache.failed",
        error: err instanceof Error ? err.message : String(err),
        message: "Redis site-cache warm failed; /ingest will use DB fallback",
      });
    }
  }
}
