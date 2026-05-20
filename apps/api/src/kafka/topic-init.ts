import { Logger } from "@nestjs/common";
import type { Kafka } from "kafkajs";

const logger = new Logger("TopicInit");

/**
 * Ensure the ingest topic exists.
 *
 * Uses the KafkaJS admin client to check whether the topic is already present
 * and creates it with 1 partition if not.
 *
 * NOTE: 1 partition is intentional for local dev. Production deployments should
 * pre-create the topic with N partitions (one per consumer instance for
 * horizontal scaling) before starting the service. Never rely on auto-creation
 * in production — auto-create is disabled on the broker
 * (`KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`).
 */
export async function ensureTopicExists(kafka: Kafka, topic: string): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const exists = metadata.topics.some((t) => t.name === topic && t.partitions.length > 0);

    if (exists) {
      logger.log({ event: "kafka.topic.already_exists", topic });
      return;
    }

    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });

    logger.log({ event: "kafka.topic.created", topic, partitions: 1 });
  } catch (err) {
    // fetchTopicMetadata throws an error with a UNKNOWN_TOPIC_OR_PARTITION code
    // when the topic doesn't exist on some broker versions — attempt creation.
    const isTopicNotFound =
      err instanceof Error &&
      (err.message.includes("UNKNOWN_TOPIC_OR_PARTITION") ||
        err.message.includes("This server does not host this topic-partition"));

    if (isTopicNotFound) {
      await admin.createTopics({
        topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
      logger.log({ event: "kafka.topic.created_after_miss", topic, partitions: 1 });
    } else {
      throw err;
    }
  } finally {
    await admin.disconnect();
  }
}
