import { Module } from "@nestjs/common";
import { SystemAlertsService } from "./system-alerts.service.ts";

@Module({
  providers: [SystemAlertsService],
  exports: [SystemAlertsService],
})
export class SystemAlertsModule {}
