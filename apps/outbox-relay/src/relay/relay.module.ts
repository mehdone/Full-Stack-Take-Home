import { Module } from "@nestjs/common";
import { OutboxDeliveredListener } from "./outbox-delivered.listener.ts";
import { OutboxRelayService } from "./outbox-relay.service.ts";

@Module({
  providers: [OutboxRelayService, OutboxDeliveredListener],
})
export class RelayModule {}
