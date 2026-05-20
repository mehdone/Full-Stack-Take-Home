import { Module } from "@nestjs/common";
import { IngestModule } from "../ingest/ingest.module.ts";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module.ts";
import { KafkaConsumerService } from "./kafka-consumer.service.ts";

@Module({
  imports: [IngestModule, SystemAlertsModule],
  providers: [KafkaConsumerService],
  exports: [KafkaConsumerService],
})
export class KafkaConsumerModule {}
