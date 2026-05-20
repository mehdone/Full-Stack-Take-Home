/**
 * Integration tests for AlertsController.
 *
 * Covers:
 * 1. POST /alerts/business with valid payload → 200
 * 2. POST /alerts/business with invalid payload → 400
 * 3. POST /alerts/system with valid payload → 200
 * 4. POST /alerts/system with invalid severity → 400
 */

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { AppModule } from "../../src/app.module.ts";

describe("AlertsController (Integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, {
      bufferLogs: true,
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /alerts/business", () => {
    it("accepts valid business alert payload", async () => {
      const payload = {
        outbox_id: "1",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440000",
          site_slug: "well-pad-1",
          measurements_inserted: 5,
          measurements_submitted: 5,
          sum_kg_co2e: "100.50",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/business")
        .send(payload)
        .expect(200);

      expect(res.body).toHaveProperty("status", "ok");
    });

    it("rejects invalid business alert payload with 400", async () => {
      const payload = {
        outbox_id: "1",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        // Missing required payload fields
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440000",
          // Missing site_slug, measurements_inserted, etc.
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/business")
        .send(payload)
        .expect(400);

      expect(res.body).toHaveProperty("error", "invalid_payload");
      expect(res.body).toHaveProperty("issues");
    });

    it("rejects alert with missing outbox_id", async () => {
      const payload = {
        // Missing outbox_id
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440000",
          site_slug: "well-pad-1",
          measurements_inserted: 5,
          measurements_submitted: 5,
          sum_kg_co2e: "100.50",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/business")
        .send(payload)
        .expect(400);

      expect(res.body.error).toBe("invalid_payload");
    });
  });

  describe("POST /alerts/system", () => {
    it("accepts valid system alert payload", async () => {
      const payload = {
        system_alert_id: "1",
        alert_type: "clock_skew_violation",
        severity: "warn",
        payload: {
          site_id: 42,
          site_slug: "well-pad-1",
          recorded_at: "2026-05-19T12:00:00Z",
          site_timezone: "America/Edmonton",
          local_time: "2026-05-19T05:00:00",
          detected_at: "2026-05-19T12:05:00Z",
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/system")
        .send(payload)
        .expect(200);

      expect(res.body).toHaveProperty("status", "ok");
    });

    it("rejects invalid system alert payload with 400", async () => {
      const payload = {
        system_alert_id: "1",
        alert_type: "clock_skew_violation",
        // Missing severity
        payload: {
          site_id: 42,
          site_slug: "well-pad-1",
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/system")
        .send(payload)
        .expect(400);

      expect(res.body.error).toBe("invalid_payload");
    });

    it("rejects system alert with invalid severity enum", async () => {
      const payload = {
        system_alert_id: "1",
        alert_type: "clock_skew_violation",
        severity: "invalid_severity",
        payload: {
          site_id: 42,
          site_slug: "well-pad-1",
        },
      };

      const res = await request(app.getHttpServer())
        .post("/alerts/system")
        .send(payload)
        .expect(400);

      expect(res.body.error).toBe("invalid_payload");
      expect(res.body.issues).toBeDefined();
    });

    it("accepts all valid severity values", async () => {
      const severities = ["info", "warn", "critical"];

      for (const severity of severities) {
        const payload = {
          system_alert_id: "1",
          alert_type: "outbox_delivery_exhausted",
          severity,
          payload: {
            site_id: 42,
          },
        };

        const res = await request(app.getHttpServer())
          .post("/alerts/system")
          .send(payload)
          .expect(200);

        expect(res.body.status).toBe("ok");
      }
    });
  });
});
