import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { KafkaConsumerService } from "./kafka/kafka-consumer.service.ts";

const bootstrapLogger = new Logger("Bootstrap");

async function bootstrap(): Promise<void> {
  // Standalone application context — no HTTP server.
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();

  const consumer = app.get(KafkaConsumerService);

  // Graceful shutdown on SIGINT (Ctrl-C) and SIGTERM (Docker / K8s stop).
  // Order: disconnect Kafka consumer → close NestJS context (closes DB pool
  // via DbModule.onApplicationShutdown) → exit.
  const shutdown = async (signal: string): Promise<void> => {
    bootstrapLogger.log({ event: "consumer.shutdown.signal", signal });
    try {
      await consumer.disconnect();
      bootstrapLogger.log({ event: "consumer.shutdown.kafka_disconnected" });
      await app.close();
      bootstrapLogger.log({ event: "consumer.shutdown.complete" });
    } catch (err) {
      bootstrapLogger.error({
        event: "consumer.shutdown.error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1));
  });

  // Start consuming. This registers the eachBatch handler and returns;
  // the process stays alive because KafkaJS holds an open long-poll connection.
  await consumer.start();

  bootstrapLogger.log({ event: "consumer.started" });
}

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Bootstrap] Fatal error: ${msg}`);
  process.exit(1);
});
