import {
  BaseEnvFragment,
  KafkaEnvFragment,
  PostgresEnvFragment,
  RedisEnvFragment,
} from "@highwood/config";
import { z } from "zod";

export const EnvSchema = BaseEnvFragment.merge(PostgresEnvFragment)
  .merge(RedisEnvFragment)
  .merge(KafkaEnvFragment)
  .extend({
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    // Batch dedupe TTL in seconds (default 24 h)
    BATCH_DEDUPE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  });

export type Env = z.infer<typeof EnvSchema>;
