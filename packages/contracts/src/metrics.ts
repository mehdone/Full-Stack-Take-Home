import { z } from "zod";
import { NumericKgSchema, SlugSchema } from "./common.ts";

export const ComplianceStatus = {
  COMPLIANT: "compliant",
  EXCEEDING: "exceeding",
} as const;

export type ComplianceStatus = (typeof ComplianceStatus)[keyof typeof ComplianceStatus];

export const ComplianceStatusSchema = z.nativeEnum(ComplianceStatus);

export const SiteMetricsSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  emission_limit_kg_co2e: NumericKgSchema,
  total_kg_co2e: NumericKgSchema,
  prior_months_total_kg_co2e: NumericKgSchema,
  current_month_to_date_kg_co2e: NumericKgSchema,
  compliance_status: ComplianceStatusSchema,
  as_of: z.string().datetime({ offset: true }),
});

export type SiteMetrics = z.infer<typeof SiteMetricsSchema>;
