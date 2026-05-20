import { z } from "zod";

/**
 * Composable environment-variable schemas shared across every app in the
 * monorepo.
 *
 * Design intent: each app keeps its own `env.schema.ts` and validates only
 * the keys it actually uses, but the SHAPE of every shared key is defined
 * here exactly once. An app that depends on Postgres composes
 * `PostgresEnvFragment`; an app that talks to Kafka composes
 * `KafkaEnvFragment`; etc.
 *
 * Example consumer:
 * ```ts
 * import { BaseEnvFragment, PostgresEnvFragment, KafkaEnvFragment }
 *   from "@highwood/config";
 *
 * export const EnvSchema = BaseEnvFragment
 *   .merge(PostgresEnvFragment)
 *   .merge(KafkaEnvFragment)
 *   .extend({
 *     CONSUMER_GROUP_ID: z.string().default("emissions-ingest-consumer"),
 *   });
 * ```
 *
 * Why fragments, not a single mega-schema:
 *   - Each app still fails boot loudly if its own env is wrong, WITHOUT
 *     failing because of a key it doesn't care about (e.g. the alerting
 *     receiver shouldn't require DATABASE_URL).
 *   - A glance at an app's `env.schema.ts` shows which subsystems it talks
 *     to (via the fragment imports), keeping the per-app contract explicit
 *     and auditable.
 */

/**
 * Always-present basics: process mode + structured-log level override.
 */
export const BaseEnvFragment = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().optional(),
});

/**
 * Postgres connection. The `startsWith` check catches the most common
 * misconfiguration (an unrelated DSN copied into DATABASE_URL).
 */
export const PostgresEnvFragment = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
});

/**
 * Redis connection. Default points at the docker-compose local instance.
 */
export const RedisEnvFragment = z.object({
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
});

/**
 * Kafka broker list (comma-separated) + the ingest topic name. Both default
 * to the docker-compose local values.
 */
export const KafkaEnvFragment = z.object({
  KAFKA_BROKERS: z.string().default("localhost:9092"),
  INGEST_TOPIC: z.string().default("emissions.ingest.v1"),
});

/**
 * URL of the alerting receiver. Consumed by the outbox relay and the
 * system-alerts relay; not needed by the API or consumer.
 */
export const AlertingClientEnvFragment = z.object({
  ALERTING_URL: z.string().url().default("http://localhost:4100"),
});

// Convenience type exports — apps that need the inferred type of a fragment
// in isolation can import these directly. Most apps compose fragments and
// infer the merged type from the resulting schema, so these are optional.
export type BaseEnv = z.infer<typeof BaseEnvFragment>;
export type PostgresEnv = z.infer<typeof PostgresEnvFragment>;
export type RedisEnv = z.infer<typeof RedisEnvFragment>;
export type KafkaEnv = z.infer<typeof KafkaEnvFragment>;
export type AlertingClientEnv = z.infer<typeof AlertingClientEnvFragment>;
