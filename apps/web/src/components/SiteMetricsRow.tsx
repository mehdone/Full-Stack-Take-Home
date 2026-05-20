"use client";

/**
 * Client component: owns the per-site metrics polling.
 *
 * Why client-side polling instead of revalidateTag?
 * - `GET /sites/:slug/metrics` is an aggregate over measurements which are
 *   written asynchronously by the Kafka consumer. There is no mutation path in
 *   the web app that can reliably trigger `revalidateTag` at the exact moment
 *   the consumer commits — the 202 Accepted from /ingest doesn't mean the DB
 *   is updated yet.
 * - A 5-second client-side poll matches the eventual-consistency window of the
 *   consumer and keeps the dashboard genuinely live without server-sent events.
 * - Each site row polls independently so a single failing slug doesn't block
 *   the rest.
 */

import { ComplianceBadge } from "@/components/ComplianceBadge";
import { ApiClientError, getSiteMetrics } from "@/lib/api";
import type { SiteMetrics, SiteResponse } from "@highwood/contracts";
import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5_000;

interface Props {
  site: SiteResponse;
}

type MetricsState =
  | { status: "loading" }
  | { status: "ok"; metrics: SiteMetrics }
  | { status: "error"; message: string };

function formatKg(value: string): string {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function SiteMetricsRow({ site }: Props) {
  const [state, setState] = useState<MetricsState>({ status: "loading" });

  const fetchMetrics = useCallback(async () => {
    try {
      const metrics = await getSiteMetrics(site.slug);
      setState({ status: "ok", metrics });
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : "Failed to load metrics";
      setState({ status: "error", message: msg });
    }
  }, [site.slug]);

  useEffect(() => {
    void fetchMetrics();
    const interval = setInterval(() => void fetchMetrics(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Prefer the structured address (city, state, country). Fall back to lat/long
  // when no city/state are recorded (industrial sites often sit outside any city).
  const addressParts = [site.city, site.state, site.country].filter(Boolean);
  const location =
    addressParts.length > 0 ? addressParts.join(", ") : `${site.latitude}, ${site.longitude}`;

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50">
      <td className="px-4 py-3">
        <a
          href={`/sites/${site.slug}`}
          className="font-mono text-sm font-medium text-blue-600 hover:underline"
        >
          {site.slug}
        </a>
      </td>
      <td className="px-4 py-3 text-sm">{site.name}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{location}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{site.timezone}</td>
      <td className="px-4 py-3 text-right text-sm font-mono">{formatKg(site.emission_limit)}</td>

      {state.status === "loading" && (
        <td colSpan={4} className="px-4 py-3 text-center text-sm text-gray-400">
          Loading metrics...
        </td>
      )}

      {state.status === "error" && (
        <td colSpan={4} className="px-4 py-3 text-center text-sm text-red-500">
          {state.message}
        </td>
      )}

      {state.status === "ok" && (
        <>
          <td className="px-4 py-3 text-right text-sm font-mono">
            {formatKg(state.metrics.total_kg_co2e)}
          </td>
          <td className="px-4 py-3 text-right text-sm font-mono">
            {formatKg(state.metrics.prior_months_total_kg_co2e)}
          </td>
          <td className="px-4 py-3 text-right text-sm font-mono">
            {formatKg(state.metrics.current_month_to_date_kg_co2e)}
          </td>
          <td className="px-4 py-3 text-center">
            <ComplianceBadge status={state.metrics.compliance_status} />
          </td>
        </>
      )}
    </tr>
  );
}
