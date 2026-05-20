/**
 * Thin API client for the Highwood Emissions API.
 *
 * All calls go through `apiFetch<T>` which:
 * 1. Prefixes the path with NEXT_PUBLIC_API_BASE_URL (default http://localhost:3000).
 * 2. Parses the { ok, data } / { ok, error } envelope.
 * 3. Throws `ApiClientError` (typed) when ok === false.
 *
 * Response shapes are validated with Zod schemas from @highwood/contracts — this
 * is the visible proof of Bonus #7 (type-safe shared contracts). No types are
 * redeclared here.
 */

import type {
  ApiError,
  IngestAccepted,
  SiteMetrics,
  SiteResponse,
  SitesListResponse,
} from "@highwood/contracts";
import {
  ErrorEnvelopeSchema,
  IngestAcceptedSchema,
  SiteMetricsSchema,
  SiteResponseSchema,
  SitesListResponseSchema,
  successEnvelope,
} from "@highwood/contracts";
import type { ZodTypeAny } from "zod";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Typed error class — thrown by apiFetch on ok === false responses
// ---------------------------------------------------------------------------

export class ApiClientError extends Error {
  public readonly code: ApiError["code"];
  public readonly details: ApiError["details"];
  public readonly request_id: ApiError["request_id"];
  public readonly status: number;

  constructor(apiError: ApiError, status: number) {
    super(apiError.message);
    this.name = "ApiClientError";
    this.code = apiError.code;
    this.details = apiError.details;
    this.request_id = apiError.request_id;
    this.status = status;
  }

  /** True for network/server errors that are safe to retry with the same batch_id */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 0;
  }
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, schema: ZodTypeAny, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...init,
    });
  } catch (networkErr) {
    // Network-level failure — surface as retryable ApiClientError
    throw new ApiClientError(
      {
        code: "INTERNAL",
        message: networkErr instanceof Error ? networkErr.message : "Network error",
      },
      0,
    );
  }

  const raw: unknown = await response.json();

  // Parse error envelope first
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(raw);
    if (parsed.success) {
      throw new ApiClientError(parsed.data.error, response.status);
    }
    // Unexpected shape — surface as generic internal error
    throw new ApiClientError(
      { code: "INTERNAL", message: `HTTP ${response.status}: unexpected error shape` },
      response.status,
    );
  }

  // Parse success envelope and validate data with the provided schema
  const envelope = successEnvelope(schema).safeParse(raw);
  if (!envelope.success) {
    throw new ApiClientError(
      {
        code: "INTERNAL",
        message: `Response did not match expected schema: ${envelope.error.message}`,
      },
      response.status,
    );
  }

  return envelope.data.data as T;
}

// ---------------------------------------------------------------------------
// Named call helpers — these are the only call sites in the app
// ---------------------------------------------------------------------------

export function getSitesList(limit = 50, cursor?: string): Promise<SitesListResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<SitesListResponse>(`/sites?${params}`, SitesListResponseSchema);
}

export function getSiteMetrics(slug: string): Promise<SiteMetrics> {
  return apiFetch<SiteMetrics>(`/sites/${slug}/metrics`, SiteMetricsSchema);
}

export function createSite(body: unknown): Promise<SiteResponse> {
  return apiFetch<SiteResponse>("/sites", SiteResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

export function ingestBatch(body: unknown): Promise<IngestAccepted> {
  return apiFetch<IngestAccepted>("/ingest", IngestAcceptedSchema, {
    method: "POST",
    body: JSON.stringify(body),
    cache: "no-store",
  });
}
