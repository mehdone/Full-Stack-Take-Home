import { BaseEnvFragment, KafkaEnvFragment, PostgresEnvFragment } from "@highwood/config";
import { z } from "zod";

/**
 * Zod-validated env schema for the Kafka consumer process. Shared keys
 * (NODE_ENV, LOG_LEVEL, DATABASE_URL, KAFKA_BROKERS, INGEST_TOPIC) come from
 * `@highwood/config` fragments; this app adds only its consumer-group ID.
 */
export const ConsumerEnvSchema = BaseEnvFragment.merge(PostgresEnvFragment)
  .merge(KafkaEnvFragment)
  .extend({
    CONSUMER_GROUP_ID: z.string().default("emissions-ingest-consumer"),
  });

export type ConsumerEnv = z.infer<typeof ConsumerEnvSchema>;
