import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service.ts";
import { REDIS_CLIENT } from "./redis.tokens.ts";

// ---------------------------------------------------------------------------
// Lua script — inlined as a string literal so the module works under both
// ESM (tsx dev runtime) and CJS (ts-jest test runtime) without needing
// `import.meta.url` or `__dirname` shims.
//
// Source of truth: `apps/api/src/redis/scripts/batch-dedupe.lua`
// Keep both in sync.
// ---------------------------------------------------------------------------

const batchDedupeScript = `
-- KEYS[1]: hash key  e.g. "ingest:dedupe:<site_slug>"
-- ARGV[1]: field     e.g. "<batch_id>"
-- ARGV[2]: ttl       e.g. "86400" (seconds)
local result = redis.call("HSETNX", KEYS[1], ARGV[1], "1")
if result == 1 then
  redis.call("HEXPIRE", KEYS[1], ARGV[2], "FIELDS", 1, ARGV[1])
end
return result
`;

// Augment the ioredis Command interface so TypeScript knows about our custom command
declare module "ioredis" {
  interface Redis {
    batchDedupe(key: string, field: string, ttl: string | number): Promise<0 | 1>;
  }
}

export { Redis };

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const redisClientProvider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Redis => {
    const client = new Redis(config.redisUrl, {
      // If Redis is down, individual commands fail immediately (no queue).
      // The app falls back to DB lookups on each failed command — correctness preserved.
      enableOfflineQueue: false,
      // Limit auto-reconnect attempts (default is unlimited). 10 fast retries
      // then ioredis backs off — prevents infinite reconnect floods in production.
      maxRetriesPerRequest: 3,
    });

    // Register the Lua dedupe script as a named command so callers use the
    // type-safe wrapper instead of raw EVAL.
    client.defineCommand("batchDedupe", {
      numberOfKeys: 1,
      lua: batchDedupeScript,
    });

    return client;
  },
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Global()
@Module({
  providers: [redisClientProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({ event: "redis.shutdown", signal: signal ?? "UNKNOWN" });
    try {
      await this.redis.quit();
    } catch {
      // quit() can fail if the connection was never established; that's fine
      this.redis.disconnect();
    }
  }
}
