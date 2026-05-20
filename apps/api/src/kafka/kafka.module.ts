import { Global, Logger, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";
import { AppConfigService } from "../config/app-config.service.ts";
import { KAFKA_PRODUCER } from "./kafka.tokens.ts";
import { ensureTopicExists } from "./topic-init.ts";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * The producer holder wraps a KafkaJS Producer together with the Kafka client
 * instance so KafkaModule can access both in lifecycle hooks.
 */
export class KafkaProducerHolder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerHolder.name);
  readonly kafka: Kafka;
  readonly producer: Producer;
  private readonly topic: string;

  constructor(brokers: string[], topic: string, clientId = "highwood-api") {
    this.topic = topic;
    this.kafka = new Kafka({
      clientId,
      brokers,
    });

    // Idempotent producer: sequence numbers + acks=all prevent duplicate
    // messages when a transient network error causes a producer-side retry.
    // This is Kafka-level dedupe distinct from the Redis (edge) and PG
    // (authoritative) layers. maxInFlightRequests=1 is mandatory for
    // idempotence with KafkaJS.
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      retry: { retries: 5 },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log({ event: "kafka.producer.connected" });

    // Ensure the ingest topic exists now that the admin connection can be made.
    await ensureTopicExists(this.kafka, this.topic);
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log({ event: "kafka.producer.disconnecting" });
    await this.producer.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const kafkaProducerHolderProvider = {
  provide: "KAFKA_PRODUCER_HOLDER",
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): KafkaProducerHolder => {
    return new KafkaProducerHolder(config.kafkaBrokers, config.ingestTopic);
  },
};

const kafkaProducerProvider = {
  provide: KAFKA_PRODUCER,
  inject: ["KAFKA_PRODUCER_HOLDER"],
  useFactory: (holder: KafkaProducerHolder): Producer => holder.producer,
};

@Global()
@Module({
  providers: [kafkaProducerHolderProvider, kafkaProducerProvider],
  exports: [KAFKA_PRODUCER],
})
export class KafkaModule {}
