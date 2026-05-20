import { z } from "zod";

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export const SlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(SLUG_REGEX, "slug must be lowercase, alphanumeric, may contain '-', 3..64 chars");

export const EMISSION_POINT_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export const EmissionPointCodeSchema = z.string().min(1).max(100).regex(EMISSION_POINT_CODE_REGEX);

/**
 * Non-negative decimal string with up to 12 integer + 6 fractional digits.
 * Matches the Postgres `numeric(18, 6)` columns used for emission values and
 * limits. Strings (not numbers) preserve precision across the wire.
 */
export const NumericKgSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, "must be a non-negative decimal with up to 6 fractional digits");

const supportedTimezones: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
);

export const TimezoneSchema = z
  .string()
  .min(1)
  .refine(
    (tz) => supportedTimezones.size === 0 || supportedTimezones.has(tz),
    "must be a valid IANA timezone name",
  );

/**
 * Unix epoch milliseconds. JS `Date.now()` returns this unit natively; the upper
 * bound matches the maximum value JS `Date` can represent (±8.64e15 ms ≈ year
 * ±287396), well within `Number.MAX_SAFE_INTEGER` (~9.0e15).
 */
export const EpochMillisecondsSchema = z
  .number()
  .int()
  .positive()
  .lt(8_640_000_000_000_000, "exceeds the maximum value JS Date can represent");
