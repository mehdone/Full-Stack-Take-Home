import { IngestBatchSchema } from "@highwood/contracts";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { type Consumer, Kafka, type KafkaMessage } from "kafkajs";
import { z } from "zod";
import { AppConfigService } from "../config/app-config.service.ts";
import type { KafkaIngestMessage } from "../ingest/ingest-handler.service.ts";
import { IngestHandlerService } from "../ingest/ingest-handler.service.ts";
import { SystemAlertsService } from "../system-alerts/system-alerts.service.ts";

/**
 * Schema for the full Kafka message value (IngestBatch + producer-appended received_at_ms).
 * Extending IngestBatchSchema here keeps the consumer's parse in sync with the contracts
 * package without re-importing @highwood/contracts/ingest a second time.
 */
const KafkaMessageSchema = IngestBatchSchema.extend({
  received_at_ms: z.number().int().positive(),
});

/**
 * KafkaConsumerService
 *
 * Subscribes to `INGEST_TOPIC` (default: `emissions.ingest.v1`) using KafkaJS.
 *
 * Design decisions:
 *
 * - `eachBatch` (not `eachMessage`): allows committing offsets in one network
 *   round-trip per Kafka batch while still processing each message in its own
 *   DB transaction. A poison message does not block subsequent messages within
 *   the same Kafka batch.
 *
 * - `autoCommit: false`: offsets are committed explicitly only after the DB
 *   transaction commits. If the DB commit fails the offset is not committed —
 *   KafkaJS replays the message on the next poll, and the unique index on
 *   `measurements(batch_id, emission_point_id, recorded_at)` makes the replay
 *   a no-op (at-least-once + idempotent-consumer pattern).
 *
 * - `fromBeginning: false`: new consumer group instances start from the current
 *   log head. Replaying historical data is an explicit admin operation.
 *
 * - Consumer group ID is configurable via `CONSUMER_GROUP_ID` env var (default:
 *   `emissions-ingest-consumer`). Useful for blue/green deploys.
 *
 * - Topic-not-found: if the topic does not exist, log a clear error and exit
 *   rather than hanging. The topic is created by the API on boot.
 */
@Injectable()
export class KafkaConsumerService {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer | null = null;
  private kafka: Kafka | null = null;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(IngestHandlerService) private readonly ingestHandler: IngestHandlerService,
    @Inject(SystemAlertsService) private readonly systemAlerts: SystemAlertsService,
  ) {}

  /**
   * Connect to Kafka, verify the topic exists, and start consuming.
   * Resolves once the consumer is running; the process stays alive because
   * KafkaJS holds an open long-poll connection.
   */
  async start(): Promise<void> {
    const brokers = this.config.kafkaBrokers;
    const topic = this.config.ingestTopic;
    const groupId = this.config.consumerGroupId;

    this.logger.log({ event: "kafka.consumer.starting", brokers, topic, groupId });

    this.kafka = new Kafka({ clientId: "highwood-consumer", brokers });

    // Verify the topic exists before subscribing; exit cleanly if not.
    await this.assertTopicExists(topic);

    this.consumer = this.kafka.consumer({ groupId });
    await this.consumer.connect();
    this.logger.log({ event: "kafka.consumer.connected", groupId });

    await this.consumer.subscribe({ topic, fromBeginning: false });
    this.logger.log({ event: "kafka.consumer.subscribed", topic });

    await this.consumer.run({
      autoCommit: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
        for (const message of batch.messages) {
          const offset = message.offset;
          const startMs = Date.now();

          try {
            await this.processMessage(message, batch.topic, batch.partition);
            resolveOffset(offset);
            await heartbeat();
            await commitOffsetsIfNecessary();
          } catch (err) {
            this.logger.error({
              event: "kafka.consumer.message_failed",
              topic: batch.topic,
              partition: batch.partition,
              offset,
              latency_ms: Date.now() - startMs,
              error: err instanceof Error ? err.message : String(err),
            });
            // Propagate to eachBatch so KafkaJS pauses and retries this partition.
            throw err;
          }
        }
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.consumer) {
      this.logger.log({ event: "kafka.consumer.disconnecting" });
      await this.consumer.disconnect();
      this.consumer = null;
    }
  }

  private async processMessage(
    message: KafkaMessage,
    topic: string,
    partition: number,
  ): Promise<void> {
    const startMs = Date.now();

    if (!message.value) {
      this.logger.warn({
        event: "kafka.consumer.empty_message",
        topic,
        partition,
        offset: message.offset,
      });
      await this.systemAlerts.insertAlert("malformed_kafka_message", {
        reason: "empty value",
        topic,
        partition,
        offset: message.offset,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.value.toString());
    } catch {
      this.logger.warn({
        event: "kafka.consumer.json_parse_failed",
        topic,
        partition,
        offset: message.offset,
      });
      await this.systemAlerts.insertAlert("malformed_kafka_message", {
        reason: "JSON parse failed",
        topic,
        partition,
        offset: message.offset,
      });
      return;
    }

    const validation = KafkaMessageSchema.safeParse(parsed);
    if (!validation.success) {
      this.logger.warn({
        event: "kafka.consumer.schema_validation_failed",
        topic,
        partition,
        offset: message.offset,
        issues: validation.error.issues,
      });
      await this.systemAlerts.insertAlert("malformed_kafka_message", {
        reason: "schema validation failed",
        issues: validation.error.issues.map((i) => i.message),
        topic,
        partition,
        offset: message.offset,
      });
      return;
    }

    const kafkaMsg: KafkaIngestMessage = validation.data;
    const result = await this.ingestHandler.handle(kafkaMsg);
    const latencyMs = Date.now() - startMs;

    this.logger.log({
      event: "ingest.batch.processed",
      site_slug: kafkaMsg.site_slug,
      batch_id: kafkaMsg.batch_id,
      inserted: result.inserted,
      duplicates: result.duplicates,
      sum_kg: result.sumKg,
      latency_ms: latencyMs,
    });
  }

  /**
   * Verify the ingest topic exists via the Kafka admin client.
   * Exits with code 1 if the topic is missing — do not hang.
   */
  private async assertTopicExists(topic: string): Promise<void> {
    if (!this.kafka) throw new Error("Kafka client not initialized");

    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const topics = await admin.listTopics();
      if (!topics.includes(topic)) {
        this.logger.error({
          event: "kafka.consumer.topic_not_found",
          topic,
          message: `Topic '${topic}' does not exist. Start the API first to auto-create it.`,
        });
        process.exit(1);
      }
    } finally {
      await admin.disconnect();
    }
  }
}
