import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";

const bootstrapLogger = new Logger("Bootstrap");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  // Health port for the system-alerts relay worker.
  const healthPort = 4102;
  await app.listen(healthPort);

  bootstrapLogger.log({
    event: "system_alerts_relay.started",
    healthPort,
    nodeEnv: config.nodeEnv,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    alertingUrl: config.alertingUrl,
  });
}

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[Bootstrap] Fatal error: ${msg}`);
  process.exit(1);
});
