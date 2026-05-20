import { Module } from "@nestjs/common";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module.ts";
import { IngestHandlerService } from "./ingest-handler.service.ts";

@Module({
  imports: [SystemAlertsModule],
  providers: [IngestHandlerService],
  exports: [IngestHandlerService],
})
export class IngestModule {}
