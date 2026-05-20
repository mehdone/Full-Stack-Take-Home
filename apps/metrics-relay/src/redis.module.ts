import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "./config/app-config.service.ts";
import { REDIS_CLIENT } from "./redis.tokens.ts";

/**
 * Lua script applied atomically by the metrics-relay for each metrics_outbox
 * row. Provides exactly-once HINCRBYFLOAT under at-least-once relay delivery.
 *
 *   KEYS[1] = applied:metrics_outbox:<id>     -- SETNX guard, per outbox row id
 *   KEYS[2] = metrics:<site_id>               -- per-site hash
 *   ARGV[1] = <yyyymm>                        -- site-local year/month, e.g. "202605"
 *   ARGV[2] = <delta_kg>                      -- the float to add (string)
 *   ARGV[3] = <applied_ttl_seconds>           -- TTL on the SETNX guard
 *   ARGV[4] = <field_ttl_seconds>             -- HEXPIRE on the hash field
 *
 *   Returns: 1 if applied this call, 0 if already applied previously.
 *
 * Why SETNX-then-HINCRBYFLOAT: HINCRBYFLOAT is not idempotent. The relay's
 * standard pattern `SELECT FOR UPDATE SKIP LOCKED → do work → UPDATE
 * delivered_at → COMMIT` prevents two replicas from racing on the same row
 * but does NOT cover the "crash between Redis call and the SQL UPDATE" window
 * — on restart that row looks undelivered and we'd HINCRBY twice → drift.
 * The SETNX guard makes the increment a no-op on re-application.
 *
 * TTL on the guard key only needs to outlive the worst-case retry window of
 * its outbox row (under defaults: ~14 minutes); 7 days is the generous slack
 * setting for operator-unfreeze scenarios.
 */
const applyIncrementScript = `
local applied = redis.call("SETNX", KEYS[1], "1")
if applied == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[3])
  redis.call("HINCRBYFLOAT", KEYS[2], ARGV[1], ARGV[2])
  redis.call("HEXPIRE", KEYS[2], ARGV[4], "FIELDS", 1, ARGV[1])
  return 1
else
  return 0
end
`;

declare module "ioredis" {
  interface Redis {
    metricsApplyIncrement(
      appliedKey: string,
      hashKey: string,
      field: string,
      delta: string,
      appliedTtlSeconds: string | number,
      fieldTtlSeconds: string | number,
    ): Promise<0 | 1>;
  }
}

export { Redis };

const redisClientProvider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Redis => {
    const client = new Redis(config.redisUrl, {
      // If Redis is down, individual commands fail immediately (no queue).
      // The relay handles this via standard backoff/attempts on the outbox row.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });

    client.defineCommand("metricsApplyIncrement", {
      numberOfKeys: 2,
      lua: applyIncrementScript,
    });

    return client;
  },
};

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
      this.redis.disconnect();
    }
  }
}
