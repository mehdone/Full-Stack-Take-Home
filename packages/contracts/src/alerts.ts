import { z } from "zod";

// ---------------------------------------------------------------------------
// Business alert — emitted by the outbox relay when an ingest batch is
// delivered to the alerting receiver. The receiver dedupes on
// (event_type, payload.batch_id) to handle at-least-once delivery.
// ---------------------------------------------------------------------------

export const AlertEnvelopeBusinessPayloadSchema = z.object({
  site_slug: z.string(),
  batch_id: z.string().uuid(),
  measurements_inserted: z.number().int().nonnegative(),
  measurements_submitted: z.number().int().positive(),
  sum_kg_co2e: z.string(),
  received_at_ms: z.number().int().positive(),
  persisted_at_ms: z.number().int().positive(),
});

export type AlertEnvelopeBusinessPayload = z.infer<typeof AlertEnvelopeBusinessPayloadSchema>;

export const AlertEnvelopeBusinessSchema = z.object({
  /**
   * Outbox row id — used as the idempotency key by the alerting receiver.
   * The relay sends this in the body so no extra header is needed; the
   * receiver stores it in its in-memory dedupe set (bounded LRU).
   */
  outbox_id: z.string(),
  event_type: z.literal("ingest.batch.persisted"),
  aggregate_id: z.string(),
  payload: AlertEnvelopeBusinessPayloadSchema,
});

export type AlertEnvelopeBusiness = z.infer<typeof AlertEnvelopeBusinessSchema>;

// ---------------------------------------------------------------------------
// System alert — emitted by the system-alerts relay for operational events
// (unknown_site_in_consumer, malformed_kafka_message, outbox_delivery_exhausted).
// ---------------------------------------------------------------------------

export const SystemAlertSeveritySchema = z.enum(["info", "warn", "critical"]);
export type SystemAlertSeverity = z.infer<typeof SystemAlertSeveritySchema>;

export const AlertEnvelopeSystemSchema = z.object({
  /**
   * system_alerts row id — included for receiver-side logging and future
   * deduplication if the sink ever persists records.
   */
  system_alert_id: z.string(),
  alert_type: z.string(),
  severity: SystemAlertSeveritySchema,
  payload: z.record(z.unknown()),
});

export type AlertEnvelopeSystem = z.infer<typeof AlertEnvelopeSystemSchema>;
