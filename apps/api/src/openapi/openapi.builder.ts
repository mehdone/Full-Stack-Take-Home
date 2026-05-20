/**
 * Builds the OpenAPI 3.0 document from the shared Zod contracts.
 *
 * Single source of truth: every request/response shape is imported from
 * @highwood/contracts. No DTOs duplicated for documentation purposes.
 */

import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import {
  ApiErrorSchema,
  CreateSiteSchema,
  ErrorEnvelopeSchema,
  IngestAcceptedSchema,
  IngestBatchSchema,
  SiteMetricsSchema,
  SiteResponseSchema,
  SitesListResponseSchema,
  successEnvelope,
} from "@highwood/contracts";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { z } from "zod";

// Idempotent: monkey-patches z.ZodType.prototype.openapi. Safe to call at module load.
extendZodWithOpenApi(z);

let cached: OpenAPIObject | null = null;

export function buildOpenApiDocument(): OpenAPIObject {
  if (cached) return cached;

  const registry = new OpenAPIRegistry();

  // --- Components ----------------------------------------------------------
  registry.register("CreateSite", CreateSiteSchema);
  const siteResponse = registry.register("SiteResponse", SiteResponseSchema);
  const sitesListResponse = registry.register("SitesListResponse", SitesListResponseSchema);
  registry.register("IngestBatch", IngestBatchSchema);
  const ingestAccepted = registry.register("IngestAccepted", IngestAcceptedSchema);
  const siteMetrics = registry.register("SiteMetrics", SiteMetricsSchema);
  registry.register("ApiError", ApiErrorSchema);
  const errorEnvelope = registry.register("ErrorEnvelope", ErrorEnvelopeSchema);

  // Success envelopes — registered as named components so the spec is browsable
  // rather than littered with inline anonymous shapes.
  const siteEnv = registry.register(
    "SiteResponseEnvelope",
    successEnvelope(SiteResponseSchema),
  );
  const sitesListEnv = registry.register(
    "SitesListResponseEnvelope",
    successEnvelope(SitesListResponseSchema),
  );
  const ingestEnv = registry.register(
    "IngestAcceptedEnvelope",
    successEnvelope(IngestAcceptedSchema),
  );
  const siteMetricsEnv = registry.register(
    "SiteMetricsEnvelope",
    successEnvelope(SiteMetricsSchema),
  );

  // Suppress "registered but unused" hints (these are referenced via $ref-by-name).
  void siteResponse;
  void sitesListResponse;
  void ingestAccepted;
  void siteMetrics;

  // --- Paths ---------------------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/sites",
    tags: ["Sites"],
    summary: "Create a site",
    description:
      "Registers a new emission-producing facility. The slug is unique and validated against the format `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: CreateSiteSchema } },
      },
    },
    responses: {
      201: {
        description: "Site created",
        content: { "application/json": { schema: siteEnv } },
      },
      400: {
        description: "Validation failed",
        content: { "application/json": { schema: errorEnvelope } },
      },
      409: {
        description: "Slug already in use",
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/sites",
    tags: ["Sites"],
    summary: "List sites",
    description: "Cursor-paginated list. Pass `next_cursor` from the previous page as `cursor`.",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50).openapi({
          description: "Page size (1..200, default 50).",
        }),
        cursor: z.string().optional().openapi({
          description: "Opaque base64 cursor returned by the previous page.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Page of sites",
        content: { "application/json": { schema: sitesListEnv } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/sites/{slug}/metrics",
    tags: ["Sites"],
    summary: "Get site metrics",
    description:
      "Returns the site's current total emissions, prior-month and current-month-to-date breakdown, and compliance status against the configured limit.",
    request: {
      params: z.object({
        slug: z.string().openapi({ description: "Site slug." }),
      }),
    },
    responses: {
      200: {
        description: "Metrics snapshot",
        content: { "application/json": { schema: siteMetricsEnv } },
      },
      404: {
        description: "Site not found",
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/ingest",
    tags: ["Ingest"],
    summary: "Ingest a batch of methane readings",
    description:
      "Accepts up to 100 readings for a single site. `batch_id` is the idempotency key — retries with the same batch_id are deduplicated and return 202 with no side effects.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: IngestBatchSchema } },
      },
    },
    responses: {
      202: {
        description: "Batch accepted (queued for persistence)",
        content: { "application/json": { schema: ingestEnv } },
      },
      400: {
        description: "Validation failed",
        content: { "application/json": { schema: errorEnvelope } },
      },
      404: {
        description: "Unknown site_slug",
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "Liveness/readiness probe",
    description:
      "Returns 200 when DB, Redis and Kafka are reachable; 503 otherwise with a per-component breakdown in `details`.",
    responses: {
      200: { description: "Healthy" },
      503: {
        description: "Degraded",
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  });

  // --- Document ------------------------------------------------------------
  const generator = new OpenApiGeneratorV3(registry.definitions);
  cached = generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Highwood Emissions Data Platform API",
      version: "1.0.0",
      description:
        "HTTP API for the Highwood Emissions ingestion and analytics engine. All success responses use the `{ ok: true, data }` envelope; all errors use `{ ok: false, error }`.",
    },
    servers: [
      { url: "http://localhost:3000", description: "Local dev (host)" },
      { url: "http://api:3000", description: "docker-compose internal network" },
    ],
    tags: [
      { name: "Sites", description: "Asset management and analytics" },
      { name: "Ingest", description: "Reliable batch ingestion" },
      { name: "Health", description: "Operational probes" },
    ],
  });

  return cached;
}
