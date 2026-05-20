import { BaseEnvFragment, PostgresEnvFragment, RedisEnvFragment } from "@highwood/config";
import { z } from "zod";

export const MetricsRelayEnvSchema = BaseEnvFragment.merge(PostgresEnvFragment)
  .merge(RedisEnvFragment)
  .extend({
    // Relay tuning — independent of the alerting outbox relay so the two can be
    // tuned without coupling. Defaults match outbox-relay for consistency.
    METRICS_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    METRICS_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    METRICS_RELAY_BACKOFF_BASE_SECONDS: z.coerce.number().positive().default(2),
    METRICS_RELAY_BACKOFF_CAP_SECONDS: z.coerce.number().positive().default(300),
    METRICS_RELAY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

    // Per-field TTL on the metrics hash. 90 days = ample window for late
    // arrivals into a closed month to still find their field present.
    METRICS_FIELD_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(90 * 24 * 60 * 60),

    // TTL on the SETNX-guard key `applied:metrics_outbox:<id>`. Only needs to
    // outlive the worst-case retry window of its outbox row, which under
    // defaults is ~14 minutes; 7 days is generous slack for operator-unfreeze
    // scenarios.
    METRICS_APPLIED_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),
  });

export type MetricsRelayEnv = z.infer<typeof MetricsRelayEnvSchema>;
