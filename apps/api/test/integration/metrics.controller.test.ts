/**
 * Integration tests for:
 *  - GET /sites/:slug/metrics
 *  - GET /sites  (list, cursor pagination)
 *
 * Covers:
 *  1. GET /sites/:slug/metrics — happy path (zero measurements)
 *  2. GET /sites/:slug/metrics — happy path with current-month measurements
 *  3. GET /sites/:slug/metrics — 404 for unknown slug
 *  4. GET /sites — empty list
 *  5. GET /sites — single-page list
 *  6. GET /sites — multi-page cursor pagination
 */

import type { DbClient } from "@highwood/db";
import { siteEmissionPoints, sites } from "@highwood/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import request from "supertest";
import { createTestApp, getDbClient, truncateTables } from "../helpers/test-app.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_SITE = {
  slug: "metrics-test-site",
  name: "Metrics Test Site",
  country: "CA",
  state: "Alberta",
  city: "Calgary",
  postal_code: "T2P 1J9",
  latitude: 51.5,
  longitude: -114.1,
  timezone: "America/Edmonton",
  emission_limit: "1000.000000",
};

async function createSiteViaApi(app: INestApplication, overrides: Partial<typeof BASE_SITE> = {}) {
  const payload = { ...BASE_SITE, ...overrides };
  const res = await request(app.getHttpServer()).post("/sites").send(payload).expect(201);
  return res.body.data as { slug: string; name: string; emission_limit: string };
}

/**
 * Insert a measurement directly into the DB for a given site + emission point.
 * Auto-creates the emission point if it doesn't exist.
 */
async function insertMeasurement(
  db: DbClient,
  siteSlug: string,
  emissionPointCode: string,
  valueKg: string,
  recordedAt: Date,
): Promise<void> {
  // Resolve site id
  const siteRows = await db.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, siteSlug));
  if (siteRows.length === 0) throw new Error(`Site '${siteSlug}' not found`);
  const siteRow = siteRows[0];
  if (!siteRow) throw new Error(`Site '${siteSlug}' not found`);
  const siteId = siteRow.id;

  // Upsert emission point
  await db.db.execute(sql`
    INSERT INTO site_emission_points (site_id, code)
    VALUES (${siteId}, ${emissionPointCode})
    ON CONFLICT (site_id, code) DO NOTHING
  `);

  const epRows = await db.db
    .select({ id: siteEmissionPoints.id })
    .from(siteEmissionPoints)
    .where(sql`site_id = ${siteId} AND code = ${emissionPointCode}`);
  if (epRows.length === 0) throw new Error("Emission point insert failed");
  const epRow = epRows[0];
  if (!epRow) throw new Error("Emission point insert failed");
  const epId = epRow.id;

  await db.db.execute(sql`
    INSERT INTO measurements (site_id, emission_point_id, batch_id, recorded_at, value)
    VALUES (
      ${siteId},
      ${epId},
      gen_random_uuid(),
      ${recordedAt.toISOString()}::timestamptz,
      ${valueKg}::numeric
    )
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /sites/:slug/metrics (Integration)", () => {
  let app: INestApplication;
  let dbClient: DbClient;

  beforeAll(async () => {
    app = await createTestApp();
    dbClient = getDbClient(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateTables(dbClient);
  });

  it("returns compliant metrics with zero emissions", async () => {
    await createSiteViaApi(app);

    const res = await request(app.getHttpServer())
      .get(`/sites/${BASE_SITE.slug}/metrics`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    const d = res.body.data;

    expect(d.slug).toBe(BASE_SITE.slug);
    expect(d.name).toBe(BASE_SITE.name);
    // Postgres numeric(18,6) → "1000.000000" round-trips as-is
    expect(d.emission_limit_kg_co2e).toBe("1000.0");
    expect(d.total_kg_co2e).toBe("0.0");
    expect(d.prior_months_total_kg_co2e).toBe("0.0");
    expect(d.current_month_to_date_kg_co2e).toBe("0.0");
    expect(d.compliance_status).toBe("compliant");
    // as_of is an ISO datetime with offset
    expect(d.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns correct metrics with current-month measurements", async () => {
    await createSiteViaApi(app, { emission_limit: "500.000000" });

    // Insert two measurements in the current month
    const now = new Date();
    await insertMeasurement(dbClient, BASE_SITE.slug, "EP-001", "200.500000", now);
    await insertMeasurement(dbClient, BASE_SITE.slug, "EP-002", "150.250000", now);

    const res = await request(app.getHttpServer())
      .get(`/sites/${BASE_SITE.slug}/metrics`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    const d = res.body.data;

    // 200.5 + 150.25 = 350.75 → Postgres gives us "350.750000", we format to "350.75"
    expect(d.current_month_to_date_kg_co2e).toBe("350.75");
    expect(d.prior_months_total_kg_co2e).toBe("0.0");
    expect(d.total_kg_co2e).toBe("350.75");
    expect(d.compliance_status).toBe("compliant"); // 350.75 <= 500
  });

  it("returns exceeding status when total > emission_limit", async () => {
    await createSiteViaApi(app, { emission_limit: "100.000000" });

    const now = new Date();
    await insertMeasurement(dbClient, BASE_SITE.slug, "EP-001", "200.000000", now);

    const res = await request(app.getHttpServer())
      .get(`/sites/${BASE_SITE.slug}/metrics`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    const d = res.body.data;

    expect(d.total_kg_co2e).toBe("200.0");
    expect(d.compliance_status).toBe("exceeding"); // 200 > 100
  });

  it("recomputes stale month data instead of using cached value", async () => {
    await createSiteViaApi(app, { emission_limit: "1000.000000" });

    // Get the site ID to insert a stale monthly record
    const siteRows = await dbClient.db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.slug, BASE_SITE.slug));
    const siteId = siteRows[0]?.id;
    expect(siteId).toBeDefined();

    // Insert a stale monthly aggregation with a deliberately wrong total
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    await dbClient.db.execute(sql`
      INSERT INTO site_monthly_emissions (site_id, year, month, total_kg, stale, computed_at)
      VALUES (${siteId}, ${year}, ${month}, '999.999999'::numeric, true, now())
    `);

    // Insert actual measurements for the current month
    await insertMeasurement(dbClient, BASE_SITE.slug, "EP-001", "50.000000", now);
    await insertMeasurement(dbClient, BASE_SITE.slug, "EP-002", "75.500000", now);

    const res = await request(app.getHttpServer())
      .get(`/sites/${BASE_SITE.slug}/metrics`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    const d = res.body.data;

    // Should use the real measurements (50 + 75.5 = 125.5), not the cached wrong value (999.999999)
    expect(d.current_month_to_date_kg_co2e).toBe("125.5");
    expect(d.prior_months_total_kg_co2e).toBe("0.0");
    expect(d.total_kg_co2e).toBe("125.5");
    expect(d.compliance_status).toBe("compliant"); // 125.5 <= 1000
  });

  it("returns 404 for unknown slug", async () => {
    const res = await request(app.getHttpServer())
      .get("/sites/does-not-exist-00/metrics")
      .expect(404);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toContain("does-not-exist-00");
  });
});

describe("GET /sites (Integration)", () => {
  let app: INestApplication;
  let dbClient: DbClient;

  beforeAll(async () => {
    app = await createTestApp();
    dbClient = getDbClient(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateTables(dbClient);
  });

  it("returns empty list when no sites exist", async () => {
    const res = await request(app.getHttpServer()).get("/sites").expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.data).toEqual([]);
    expect(res.body.data.next_cursor).toBeNull();
  });

  it("returns all sites on a single page", async () => {
    await createSiteViaApi(app, { slug: "site-alpha", name: "Alpha" });
    await createSiteViaApi(app, { slug: "site-beta", name: "Beta" });

    const res = await request(app.getHttpServer()).get("/sites").expect(200);

    expect(res.body.ok).toBe(true);
    const { data, next_cursor } = res.body.data as { data: unknown[]; next_cursor: string | null };
    expect(data).toHaveLength(2);
    expect(next_cursor).toBeNull();
  });

  it("paginates correctly with cursor", async () => {
    await createSiteViaApi(app, { slug: "site-one", name: "One" });
    await createSiteViaApi(app, { slug: "site-two", name: "Two" });
    await createSiteViaApi(app, { slug: "site-three", name: "Three" });

    // First page
    const page1 = await request(app.getHttpServer()).get("/sites?limit=2").expect(200);
    expect(page1.body.ok).toBe(true);
    const { data: items1, next_cursor: cursor1 } = page1.body.data as {
      data: Array<{ slug: string }>;
      next_cursor: string | null;
    };
    expect(items1).toHaveLength(2);
    expect(cursor1).not.toBeNull();

    // Second page using the cursor
    const page2 = await request(app.getHttpServer())
      .get(`/sites?limit=2&cursor=${cursor1}`)
      .expect(200);
    expect(page2.body.ok).toBe(true);
    const { data: items2, next_cursor: cursor2 } = page2.body.data as {
      data: Array<{ slug: string }>;
      next_cursor: string | null;
    };
    expect(items2).toHaveLength(1);
    expect(cursor2).toBeNull();

    // No slug should appear in both pages
    const slugs1 = items1.map((s) => s.slug);
    const slugs2 = items2.map((s) => s.slug);
    expect(slugs1.some((s) => slugs2.includes(s))).toBe(false);
    // Combined set contains all 3 slugs
    expect([...slugs1, ...slugs2].sort()).toEqual(["site-one", "site-three", "site-two"].sort());
  });

  it("returns 400 for limit exceeding max (200)", async () => {
    const res = await request(app.getHttpServer()).get("/sites?limit=999").expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for limit = 0", async () => {
    const res = await request(app.getHttpServer()).get("/sites?limit=0").expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});
