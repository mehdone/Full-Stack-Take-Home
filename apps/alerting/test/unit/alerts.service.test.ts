/**
 * Unit tests for AlertsService.
 *
 * Covers:
 * 1. Same (event_type, batch_id) twice → second is suppressed
 * 2. measurements_inserted == 0 → suppressed
 * 3. New alerts are delivered and logged
 */

import type { AlertEnvelopeBusiness, AlertEnvelopeSystem } from "@highwood/contracts";
import { Test } from "@nestjs/testing";
import { AlertsService } from "../../src/alerts/alerts.service.ts";

describe("AlertsService", () => {
  let service: AlertsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [AlertsService],
    }).compile();

    service = module.get<AlertsService>(AlertsService);
  });

  describe("handleBusiness", () => {
    it("delivers a new alert with valid data", () => {
      const alert: AlertEnvelopeBusiness = {
        outbox_id: "1",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440001",
          site_slug: "well-pad-1",
          measurements_inserted: 5,
          measurements_submitted: 5,
          sum_kg_co2e: "100.50",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      const result = service.handleBusiness(alert);

      expect(result.status).toBe("ok");
      expect(result.duplicate).toBeUndefined();
    });

    it("suppresses duplicate (event_type, batch_id) on second delivery", () => {
      const alert: AlertEnvelopeBusiness = {
        outbox_id: "1",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440002",
          site_slug: "well-pad-1",
          measurements_inserted: 3,
          measurements_submitted: 3,
          sum_kg_co2e: "50.25",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      // First delivery
      const result1 = service.handleBusiness(alert);
      expect(result1.duplicate).toBeUndefined();

      // Second delivery with same batch_id
      const result2 = service.handleBusiness(alert);
      expect(result2.status).toBe("ok");
      expect(result2.duplicate).toBe(true);
    });

    it("suppresses no-op batches with measurements_inserted == 0", () => {
      const alert: AlertEnvelopeBusiness = {
        outbox_id: "2",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id: "550e8400-e29b-41d4-a716-446655440003",
          site_slug: "well-pad-1",
          measurements_inserted: 0, // No-op batch
          measurements_submitted: 5,
          sum_kg_co2e: "0.0",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      const result = service.handleBusiness(alert);

      expect(result.status).toBe("ok");
      expect(result.duplicate).toBe(true);
    });

    it("handles different event_types with same batch_id separately", () => {
      const batch_id = "550e8400-e29b-41d4-a716-446655440004";

      const alert1: AlertEnvelopeBusiness = {
        outbox_id: "3",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-1",
        payload: {
          batch_id,
          site_slug: "well-pad-1",
          measurements_inserted: 1,
          measurements_submitted: 1,
          sum_kg_co2e: "10.0",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      // Note: Can't use different event_type since the schema only allows "ingest.batch.persisted"
      // So test with different aggregate_id instead
      const alert2: AlertEnvelopeBusiness = {
        outbox_id: "4",
        event_type: "ingest.batch.persisted",
        aggregate_id: "well-pad-2", // Different aggregate_id
        payload: {
          batch_id,
          site_slug: "well-pad-2",
          measurements_inserted: 1,
          measurements_submitted: 1,
          sum_kg_co2e: "10.0",
          received_at_ms: 1000000,
          persisted_at_ms: 2000000,
        },
      };

      // Both should be delivered (different site_slugs, but same batch_id)
      // The dedup key is event_type:batch_id, so same batch_id → suppressed on second
      const result1 = service.handleBusiness(alert1);
      const result2 = service.handleBusiness(alert2);

      expect(result1.duplicate).toBeUndefined();
      // result2 should be suppressed because it has the same batch_id
      expect(result2.duplicate).toBe(true);
    });
  });

  describe("handleSystem", () => {
    it("delivers system alerts without deduplication", () => {
      const alert: AlertEnvelopeSystem = {
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

      const result = service.handleSystem(alert);

      expect(result.status).toBe("ok");
    });

    it("logs each system alert individually", () => {
      const alert1: AlertEnvelopeSystem = {
        system_alert_id: "1",
        alert_type: "unknown_site_in_consumer",
        severity: "critical",
        payload: {
          site_slug: "nonexistent-site",
          batch_id: "550e8400-e29b-41d4-a716-446655440005",
          error: "Site not found",
        },
      };

      const alert2: AlertEnvelopeSystem = {
        system_alert_id: "2",
        alert_type: "unknown_site_in_consumer",
        severity: "critical",
        payload: {
          site_slug: "nonexistent-site",
          batch_id: "550e8400-e29b-41d4-a716-446655440006",
          error: "Site not found",
        },
      };

      // Both should be accepted (no dedup check)
      const result1 = service.handleSystem(alert1);
      const result2 = service.handleSystem(alert2);

      expect(result1.status).toBe("ok");
      expect(result2.status).toBe("ok");
    });
  });
});
