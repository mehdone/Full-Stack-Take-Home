import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module.ts";
import { AppConfigService } from "./config/app-config.service.ts";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const port = config.port;

  await app.listen(port);

  const logger = new Logger("Bootstrap");
  logger.log({ event: "alerting.started", port, nodeEnv: config.nodeEnv });
}

bootstrap().catch((err) => {
  console.error("Fatal bootstrap error", err);
  process.exit(1);
});
