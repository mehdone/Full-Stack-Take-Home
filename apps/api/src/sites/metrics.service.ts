import type { SiteMetrics, SiteResponse, SitesListResponse } from "@highwood/contracts";
import type { DbClient } from "@highwood/db";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB_CLIENT } from "../db/db.tokens.ts";

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  // ---------------------------------------------------------------------------
  // GET /sites/:slug/metrics
  // ---------------------------------------------------------------------------

  async getSiteMetrics(slug: string): Promise<SiteMetrics> {
    const startMs = Date.now();

    // All reads happen inside one read-only tx for snapshot consistency.
    const result = await this.db.db.transaction(async (tx) => {
      // 1. Resolve the site by slug.
      type SiteRow = {
        id: bigint;
        slug: string;
        name: string;
        emissionLimit: string;
        timezone: string;
      };

      const siteRows = await tx.execute<SiteRow>(sql`
        SELECT id, slug, name, emission_limit AS "emissionLimit", timezone
        FROM sites
        WHERE slug = ${slug}
        LIMIT 1
      `);

      if (siteRows.length === 0) {
        throw new NotFoundException({
          message: `Site '${slug}' not found`,
          details: { slug },
        });
      }

      const site = siteRows[0] as SiteRow;

      // 2. Determine the start of the current month in the site's local timezone
      //    using a single Postgres expression to avoid any Node/Postgres clock skew.
      //    `date_trunc('month', now() AT TIME ZONE tz)` → local-tz midnight of month start.
      //    `AT TIME ZONE tz` on the result converts it back to a UTC timestamptz.
      type MonthBoundaryRow = { currentMonthStart: string | Date; asOf: string | Date };
      const boundaryRows = await tx.execute<MonthBoundaryRow>(sql`
        SELECT
          date_trunc('month', now() AT TIME ZONE ${site.timezone}) AT TIME ZONE ${site.timezone}
            AS "currentMonthStart",
          now() AS "asOf"
      `);
      const boundary = boundaryRows[0] as MonthBoundaryRow;
      const currentMonthStart = toDate(boundary.currentMonthStart);
      const asOf = toDate(boundary.asOf);

      // Derive year/month of the *current* month in local tz so we can exclude those
      // rows from the `site_monthly_emissions` aggregation.
      // We ask Postgres to give us the (year, month) integers directly.
      type CurrentYMRow = { currentYear: number; currentMonth: number };
      const ymRows = await tx.execute<CurrentYMRow>(sql`
        SELECT
          EXTRACT(YEAR  FROM now() AT TIME ZONE ${site.timezone})::int AS "currentYear",
          EXTRACT(MONTH FROM now() AT TIME ZONE ${site.timezone})::int AS "currentMonth"
      `);
      const { currentYear, currentMonth } = ymRows[0] as CurrentYMRow;

      // 3. Sum prior closed months from site_monthly_emissions.
      //    For rows where is_stale = true, recompute from measurements on the fly;
      //    for clean rows use the cached total_kg value.
      //    We do this in a single CTE query to avoid multiple round-trips.
      //
      //    CTE strategy:
      //      a) Pull all site_monthly_emissions rows for months < current (year, month).
      //      b) LEFT JOIN against aggregated measurements for those same months
      //         (needed for stale-row recompute).
      //      c) CASE WHEN stale THEN meas_sum ELSE cached_total END → effective total.
      type PriorMonthsRow = { priorTotal: string };
      const priorMonthsRows = await tx.execute<PriorMonthsRow>(sql`
        WITH monthly AS (
          SELECT
            sme.year,
            sme.month,
            sme.stale,
            sme.total_kg::numeric AS cached_total
          FROM site_monthly_emissions sme
          WHERE sme.site_id = ${site.id}
            AND (sme.year < ${currentYear}
                 OR (sme.year = ${currentYear} AND sme.month < ${currentMonth}))
        ),
        meas_agg AS (
          -- Recompute emissions per (year, month) for stale rows only.
          -- Bucket recorded_at into local-tz year+month to match the cached rows.
          SELECT
            EXTRACT(YEAR  FROM m.recorded_at AT TIME ZONE ${site.timezone})::int AS year,
            EXTRACT(MONTH FROM m.recorded_at AT TIME ZONE ${site.timezone})::int AS month,
            SUM(m.value::numeric) AS meas_sum
          FROM measurements m
          JOIN site_emission_points sep ON sep.id = m.emission_point_id
          WHERE sep.site_id = ${site.id}
            AND (
              EXTRACT(YEAR  FROM m.recorded_at AT TIME ZONE ${site.timezone})::int < ${currentYear}
              OR (
                EXTRACT(YEAR  FROM m.recorded_at AT TIME ZONE ${site.timezone})::int = ${currentYear}
                AND EXTRACT(MONTH FROM m.recorded_at AT TIME ZONE ${site.timezone})::int < ${currentMonth}
              )
            )
          GROUP BY 1, 2
        )
        SELECT
          COALESCE(
            SUM(
              CASE WHEN mo.stale
                THEN COALESCE(ma.meas_sum, 0)
                ELSE mo.cached_total
              END
            ),
            0
          )::text AS "priorTotal"
        FROM monthly mo
        LEFT JOIN meas_agg ma ON ma.year = mo.year AND ma.month = mo.month
      `);
      const priorTotal = (priorMonthsRows[0] as PriorMonthsRow).priorTotal ?? "0";

      // 4. Sum the current month-to-date directly from measurements.
      type CurrentMonthRow = { currentMonthTotal: string };
      const currentMonthRows = await tx.execute<CurrentMonthRow>(sql`
        SELECT COALESCE(SUM(m.value::numeric), 0)::text AS "currentMonthTotal"
        FROM measurements m
        JOIN site_emission_points sep ON sep.id = m.emission_point_id
        WHERE sep.site_id = ${site.id}
          AND m.recorded_at >= ${currentMonthStart.toISOString()}::timestamptz
      `);
      const currentMonthTotal = (currentMonthRows[0] as CurrentMonthRow).currentMonthTotal ?? "0";

      return { site, priorTotal, currentMonthTotal, asOf };
    });

    // 5. Compute total and compliance in Postgres numeric string arithmetic.
    //    Add as decimals with full precision — use BigInt-safe approach via string math.
    const totalKg = addDecimalStrings(result.priorTotal, result.currentMonthTotal);

    // Compliance: total <= emission_limit → compliant, else exceeding.
    // Compare as Postgres decimals (already strings); use JS parseFloat — both values
    // come from Postgres numeric columns so they are exact representations with at
    // most 6 fractional digits (well within Number.MAX_SAFE_INTEGER for realistic
    // emission values). For the long-term safety note see ARCHITECTURE.md.
    const compliance =
      compareNumericStrings(totalKg, result.site.emissionLimit) <= 0
        ? ("compliant" as const)
        : ("exceeding" as const);

    const elapsed = Date.now() - startMs;
    this.logger.log({
      event: "metrics.read",
      slug,
      priorTotal: result.priorTotal,
      currentMonthTotal: result.currentMonthTotal,
      totalKg,
      compliance,
      elapsedMs: elapsed,
    });

    return {
      slug: result.site.slug,
      name: result.site.name,
      emission_limit_kg_co2e: formatNumeric(result.site.emissionLimit),
      total_kg_co2e: formatNumeric(totalKg),
      prior_months_total_kg_co2e: formatNumeric(result.priorTotal),
      current_month_to_date_kg_co2e: formatNumeric(result.currentMonthTotal),
      compliance_status: compliance,
      as_of: result.asOf.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /sites (cursor-based list)
  // ---------------------------------------------------------------------------

  async listSites(limit: number, cursor?: string): Promise<SitesListResponse> {
    const startMs = Date.now();

    let cursorId: bigint | null = null;
    if (cursor) {
      cursorId = decodeCursor(cursor);
    }

    // Fetch limit+1 rows for next-page lookahead
    const fetchLimit = limit + 1;

    type SiteRow = {
      id: string;
      slug: string;
      name: string;
      country: string;
      state: string | null;
      city: string | null;
      postal_code: string | null;
      latitude: string;
      longitude: string;
      timezone: string;
      emissionLimit: string;
      createdAt: string | Date;
      updatedAt: string | Date;
    };

    let rows: SiteRow[];

    if (cursorId !== null) {
      rows = await this.db.db.execute<SiteRow>(sql`
        SELECT
          id::text           AS id,
          slug,
          name,
          country,
          state,
          city,
          postal_code,
          latitude::text     AS latitude,
          longitude::text    AS longitude,
          timezone,
          emission_limit     AS "emissionLimit",
          created_at         AS "createdAt",
          updated_at         AS "updatedAt"
        FROM sites
        WHERE id > ${cursorId}::bigint
        ORDER BY id ASC
        LIMIT ${fetchLimit}
      `);
    } else {
      rows = await this.db.db.execute<SiteRow>(sql`
        SELECT
          id::text           AS id,
          slug,
          name,
          country,
          state,
          city,
          postal_code,
          latitude::text     AS latitude,
          longitude::text    AS longitude,
          timezone,
          emission_limit     AS "emissionLimit",
          created_at         AS "createdAt",
          updated_at         AS "updatedAt"
        FROM sites
        ORDER BY id ASC
        LIMIT ${fetchLimit}
      `);
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow ? encodeCursor(BigInt(lastRow.id)) : null;

    const data: SiteResponse[] = pageRows.map((r) => ({
      slug: r.slug,
      name: r.name,
      country: r.country,
      state: r.state ?? null,
      city: r.city ?? null,
      postal_code: r.postal_code ?? null,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      timezone: r.timezone,
      emission_limit: r.emissionLimit,
      created_at: toDate(r.createdAt).toISOString(),
      updated_at: toDate(r.updatedAt).toISOString(),
    }));

    const elapsed = Date.now() - startMs;
    this.logger.log({
      event: "sites.list",
      limit,
      cursor: cursor ?? null,
      returnedCount: data.length,
      hasNextPage,
      elapsedMs: elapsed,
    });

    return { data, next_cursor: nextCursor };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Add two decimal strings without loss of precision.
 * Both values come from Postgres `numeric(18,6)` columns so they have at most
 * 6 fractional digits. We convert to scaled BigInts (multiply by 10^6) to avoid
 * floating-point rounding, then format back to a decimal string.
 */
function addDecimalStrings(a: string, b: string): string {
  const SCALE = 1_000_000n;
  const scaledA = parseToScaledBigInt(a, SCALE);
  const scaledB = parseToScaledBigInt(b, SCALE);
  const sum = scaledA + scaledB;
  return formatScaledBigInt(sum, SCALE);
}

function parseToScaledBigInt(val: string, scale: bigint): bigint {
  const [intPart = "0", fracPart = ""] = val.split(".");
  const fracPadded = fracPart.padEnd(6, "0").slice(0, 6);
  return BigInt(intPart) * scale + BigInt(fracPadded);
}

function formatScaledBigInt(scaled: bigint, scale: bigint): string {
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  return `${intPart}.${String(fracPart).padStart(6, "0")}`;
}

/**
 * Compare two non-negative decimal strings. Returns negative, zero, or positive.
 * Uses the same scaled-BigInt approach as `addDecimalStrings` for correctness.
 */
function compareNumericStrings(a: string, b: string): number {
  const SCALE = 1_000_000n;
  const scaledA = parseToScaledBigInt(a, SCALE);
  const scaledB = parseToScaledBigInt(b, SCALE);
  if (scaledA < scaledB) return -1;
  if (scaledA > scaledB) return 1;
  return 0;
}

/**
 * Ensure a Postgres numeric string always has exactly 6 fractional digits,
 * matching the NumericKgSchema wire format regex `^\d{1,12}(\.\d{1,6})?$`.
 * Postgres returns `numeric(18,6)` with trailing zeros (e.g. "1000.500000"),
 * so this is normally a no-op, but we normalise here defensively.
 */
function formatNumeric(val: string): string {
  const [intPart = "0", fracPart = ""] = val.split(".");
  const fracNorm = fracPart.padEnd(6, "0").slice(0, 6);
  // Strip unnecessary trailing zeros down to at least 1 fractional digit
  // to match the contract regex which allows 1–6 fractional digits.
  // Actually the regex requires \d{1,6} so we keep at least 1 digit.
  const fracTrimmed = fracNorm.replace(/0+$/, "") || "0";
  return `${intPart}.${fracTrimmed}`;
}

// Cursor is base64(`id:${bigserial}`). Ordering is by `id` ASC — bigserial is
// monotonic and unique, so it gives the same "insertion order" semantics as
// `(created_at, id)` without the timestamptz→Date round-trip precision loss.
function encodeCursor(id: bigint): string {
  return Buffer.from(`id:${id.toString()}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): bigint | null {
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    if (!raw.startsWith("id:")) return null;
    return BigInt(raw.slice(3));
  } catch {
    return null;
  }
}
