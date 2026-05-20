import { z } from "zod";
import {
  EmissionPointCodeSchema,
  EpochMillisecondsSchema,
  NumericKgSchema,
  SlugSchema,
} from "./common.ts";

export const MEASUREMENTS_PER_BATCH_MAX = 100;

export const MeasurementInputSchema = z.object({
  emission_point: EmissionPointCodeSchema,
  recorded_at_ms: EpochMillisecondsSchema,
  value_kg_co2e: NumericKgSchema,
});

export type MeasurementInput = z.infer<typeof MeasurementInputSchema>;

export const IngestBatchSchema = z.object({
  batch_id: z.string().uuid(),
  site_slug: SlugSchema,
  measurements: z.array(MeasurementInputSchema).min(1).max(MEASUREMENTS_PER_BATCH_MAX),
});

export type IngestBatchInput = z.infer<typeof IngestBatchSchema>;

export const IngestAcceptedSchema = z.object({
  batch_id: z.string().uuid(),
  status: z.literal("queued"),
  measurements_received: z.number().int().nonnegative(),
});

export type IngestAccepted = z.infer<typeof IngestAcceptedSchema>;
