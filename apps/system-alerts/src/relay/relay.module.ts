import { Module } from "@nestjs/common";
import { SystemAlertsRelayService } from "./system-alerts-relay.service.ts";

@Module({
  providers: [SystemAlertsRelayService],
})
export class RelayModule {}
