/**
 * Integration tests for POST /sites endpoint.
 *
 * Covers:
 * 1. Happy path: Valid site creation returns 201 with correct envelope and persisted data
 * 2. Validation failure: Missing required fields returns 400 with envelope and details
 * 3. Duplicate slug: Creating a site with an existing slug returns 409 with envelope
 */

import type { DbClient } from "@highwood/db";
import { sites } from "@highwood/db";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createTestApp, getDbClient, truncateTables } from "../helpers/test-app.ts";

describe("POST /sites (Integration)", () => {
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

  describe("Happy path", () => {
    it("should create a site and return 201 with success envelope", async () => {
      const payload = {
        slug: "well-pad-1",
        name: "North Well Pad",
        country: "CA",
        state: "Alberta",
        city: "Edmonton",
        postal_code: "T5J 0N3",
        latitude: 51.5,
        longitude: -114.1,
        timezone: "America/Edmonton",
        emission_limit: "1000.50",
      };

      const res = await request(app.getHttpServer()).post("/sites").send(payload).expect(201);

      // Check success envelope shape
      expect(res.body).toHaveProperty("ok", true);
      expect(res.body).toHaveProperty("data");
      expect(res.body.error).toBeUndefined();

      const data = res.body.data;

      // Verify all fields are returned with correct types
      expect(data.slug).toBe("well-pad-1");
      expect(data.name).toBe("North Well Pad");
      expect(data.country).toBe("CA");
      expect(data.state).toBe("Alberta");
      expect(data.city).toBe("Edmonton");
      expect(data.postal_code).toBe("T5J 0N3");
      expect(data.latitude).toBe(51.5);
      expect(data.longitude).toBe(-114.1);
      expect(data.timezone).toBe("America/Edmonton");
      // Postgres canonicalizes numeric(18,6) to the column scale on read,
      // so "1000.50" round-trips as "1000.500000".
      expect(data.emission_limit).toBe("1000.500000");

      // Verify timestamps are ISO-8601 with offset
      expect(data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify record was persisted in database
      const persisted = await dbClient.db.query.sites.findFirst({
        where: eq(sites.slug, "well-pad-1"),
      });

      expect(persisted).toBeDefined();
      expect(persisted?.slug).toBe("well-pad-1");
      expect(persisted?.name).toBe("North Well Pad");
      expect(persisted?.country).toBe("CA");
      expect(persisted?.emissionLimit).toBe("1000.500000");
    });

    it("should handle optional state / city / postal_code as null", async () => {
      const payload = {
        slug: "well-pad-2",
        name: "South Well Pad",
        country: "US",
        latitude: 50.0,
        longitude: -115.0,
        timezone: "America/Denver",
        emission_limit: "500.00",
        // Omit state, city, postal_code
      };

      const res = await request(app.getHttpServer()).post("/sites").send(payload).expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.country).toBe("US");
      expect(res.body.data.state).toBeNull();
      expect(res.body.data.city).toBeNull();
      expect(res.body.data.postal_code).toBeNull();

      const persisted = await dbClient.db.query.sites.findFirst({
        where: eq(sites.slug, "well-pad-2"),
      });

      expect(persisted?.state).toBeNull();
      expect(persisted?.city).toBeNull();
      expect(persisted?.postalCode).toBeNull();
    });
  });

  describe("Validation failures", () => {
    it("should return 400 with VALIDATION_FAILED when missing required fields", async () => {
      const res = await request(app.getHttpServer()).post("/sites").send({}).expect(400);

      // Check error envelope shape
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      expect(res.body.error.message).toBeDefined();
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.request_id).toBeDefined();

      // Zod issues should be present in details
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);

      // At least slug, name, and timezone should be missing
      const paths = res.body.error.details.map(
        (issue: Record<string, unknown>) => (issue.path as unknown[] | undefined)?.[0],
      );
      expect(paths).toContain("slug");
      expect(paths).toContain("name");
      expect(paths).toContain("timezone");
    });

    it("should return 400 when slug is invalid (too short)", async () => {
      const res = await request(app.getHttpServer())
        .post("/sites")
        .send({
          slug: "a", // Too short, min 3
          name: "Test Site",
          latitude: 51.5,
          longitude: -114.1,
          timezone: "America/Edmonton",
          emission_limit: "100.00",
        })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const slugIssue = res.body.error.details.find(
        (issue: Record<string, unknown>) => (issue.path as unknown[] | undefined)?.[0] === "slug",
      );
      expect(slugIssue).toBeDefined();
    });

    it("should return 400 when latitude is out of range", async () => {
      const res = await request(app.getHttpServer())
        .post("/sites")
        .send({
          slug: "well-pad-3",
          name: "Test Site",
          latitude: 91, // Out of range
          longitude: -114.1,
          timezone: "America/Edmonton",
          emission_limit: "100.00",
        })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const latIssue = res.body.error.details.find(
        (issue: Record<string, unknown>) =>
          (issue.path as unknown[] | undefined)?.[0] === "latitude",
      );
      expect(latIssue).toBeDefined();
    });

    it("should return 400 when timezone is invalid", async () => {
      const res = await request(app.getHttpServer())
        .post("/sites")
        .send({
          slug: "well-pad-4",
          name: "Test Site",
          latitude: 51.5,
          longitude: -114.1,
          timezone: "Invalid/Timezone",
          emission_limit: "100.00",
        })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const tzIssue = res.body.error.details.find(
        (issue: Record<string, unknown>) =>
          (issue.path as unknown[] | undefined)?.[0] === "timezone",
      );
      expect(tzIssue).toBeDefined();
    });

    it("should return 400 when emission_limit is invalid format", async () => {
      const res = await request(app.getHttpServer())
        .post("/sites")
        .send({
          slug: "well-pad-5",
          name: "Test Site",
          latitude: 51.5,
          longitude: -114.1,
          timezone: "America/Edmonton",
          emission_limit: "not-a-number",
        })
        .expect(400);

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const limitIssue = res.body.error.details.find(
        (issue: Record<string, unknown>) =>
          (issue.path as unknown[] | undefined)?.[0] === "emission_limit",
      );
      expect(limitIssue).toBeDefined();
    });
  });

  describe("Duplicate slug handling", () => {
    it("should return 409 CONFLICT when creating a site with an existing slug", async () => {
      const payload = {
        slug: "well-pad-1",
        name: "First Site",
        latitude: 51.5,
        longitude: -114.1,
        timezone: "America/Edmonton",
        emission_limit: "1000.00",
      };

      // Create the first site
      await request(app.getHttpServer()).post("/sites").send(payload).expect(201);

      // Attempt to create a second site with the same slug
      const res = await request(app.getHttpServer())
        .post("/sites")
        .send({
          slug: "well-pad-1",
          name: "Second Site (different name)",
          latitude: 50.0,
          longitude: -115.0,
          timezone: "America/Denver",
          emission_limit: "500.00",
        })
        .expect(409);

      // Check error envelope
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("CONFLICT");
      expect(res.body.error.message).toBeDefined();
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.details.slug).toBe("well-pad-1");
      expect(res.body.error.request_id).toBeDefined();

      // Verify only one site exists in the database
      const allSites = await dbClient.db.query.sites.findMany();
      expect(allSites).toHaveLength(1);
      expect(allSites[0]?.name).toBe("First Site");
    });
  });
});
