import { AlertingClientEnvFragment, BaseEnvFragment, PostgresEnvFragment } from "@highwood/config";
import { z } from "zod";

export const SystemAlertsRelayEnvSchema = BaseEnvFragment.merge(PostgresEnvFragment)
  .merge(AlertingClientEnvFragment)
  .extend({
    // Relay tuning (prefixed SYSTEM_ALERTS_ to avoid clash with outbox-relay)
    SYSTEM_ALERTS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    SYSTEM_ALERTS_BATCH_SIZE: z.coerce.number().int().positive().default(25),
    SYSTEM_ALERTS_BACKOFF_BASE_SECONDS: z.coerce.number().positive().default(2),
    SYSTEM_ALERTS_BACKOFF_CAP_SECONDS: z.coerce.number().positive().default(300),
    SYSTEM_ALERTS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  });

export type SystemAlertsRelayEnv = z.infer<typeof SystemAlertsRelayEnvSchema>;
