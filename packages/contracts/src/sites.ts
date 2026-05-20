import { z } from "zod";
import { NumericKgSchema, SlugSchema, TimezoneSchema } from "./common.ts";

// ISO 3166-1 alpha-2 country code (two uppercase letters). Validated by shape, not
// by membership in an authoritative list — keeping the list current is out of scope
// and rejecting valid codes (e.g. newly-issued ones) would be worse than accepting
// a misspelling.
const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "country must be an ISO 3166-1 alpha-2 code, e.g. 'US'");

const StateSchema = z.string().min(1).max(100);
const CitySchema = z.string().min(1).max(100);
// Postal codes vary wildly across countries (e.g. UK 'SW1A 1AA', Brazil '01310-100',
// US '12345-6789'). Enforce length bounds only; let the country-specific format slide.
const PostalCodeSchema = z.string().min(1).max(20);

export const CreateSiteSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(200),
  country: CountryCodeSchema,
  state: StateSchema.optional(),
  city: CitySchema.optional(),
  postal_code: PostalCodeSchema.optional(),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  timezone: TimezoneSchema,
  emission_limit: NumericKgSchema,
});

export type CreateSiteInput = z.infer<typeof CreateSiteSchema>;

export const SiteResponseSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  country: CountryCodeSchema,
  state: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: TimezoneSchema,
  emission_limit: NumericKgSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export type SiteResponse = z.infer<typeof SiteResponseSchema>;

/**
 * Query params for GET /sites (cursor-based pagination).
 * `limit` is coerced from a string query param to a number.
 * `cursor` is an opaque base64 string: base64(`${created_at_iso}_${id}`).
 */
export const SitesListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type SitesListQuery = z.infer<typeof SitesListQuerySchema>;

/**
 * Response for GET /sites — paginated list of sites with an opaque cursor.
 */
export const SitesListResponseSchema = z.object({
  data: z.array(SiteResponseSchema),
  next_cursor: z.string().nullable(),
});

export type SitesListResponse = z.infer<typeof SitesListResponseSchema>;
