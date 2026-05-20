import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { OutboxDeliveredEvent } from "./outbox-relay.service.ts";

/**
 * Listener for the `outbox.delivered` NestJS event.
 *
 * This is the "Events post-commit" extension point described in the Phase 5
 * spec. Current behaviour: emit a structured log line. Future extensions can
 * subscribe to `outbox.delivered` without touching the relay service.
 */
@Injectable()
export class OutboxDeliveredListener {
  private readonly logger = new Logger(OutboxDeliveredListener.name);

  @OnEvent("outbox.delivered")
  handle(event: OutboxDeliveredEvent): void {
    this.logger.log({
      event: "outbox.delivered.processed",
      outbox_id: event.outboxId,
      event_type: event.eventType,
      aggregate_id: event.aggregateId,
    });
  }
}
