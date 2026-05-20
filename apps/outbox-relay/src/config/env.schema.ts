import { AlertingClientEnvFragment, BaseEnvFragment, PostgresEnvFragment } from "@highwood/config";
import { z } from "zod";

export const OutboxRelayEnvSchema = BaseEnvFragment.merge(PostgresEnvFragment)
  .merge(AlertingClientEnvFragment)
  .extend({
    // Relay tuning
    OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(25),
    OUTBOX_BACKOFF_BASE_SECONDS: z.coerce.number().positive().default(2),
    OUTBOX_BACKOFF_CAP_SECONDS: z.coerce.number().positive().default(300),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  });

export type OutboxRelayEnv = z.infer<typeof OutboxRelayEnvSchema>;
