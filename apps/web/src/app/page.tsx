/**
 * Dashboard page — Server Component.
 *
 * Fetches the first page of sites server-side (cache: 'no-store' so every
 * navigation gets a fresh list). The per-site metrics are polled client-side
 * in SiteMetricsRow on a 5-second interval — see that component for rationale.
 */

import { SitesTable } from "@/components/SitesTable";
import { ApiClientError, getSitesList } from "@/lib/api";
import type { SiteResponse } from "@highwood/contracts";

export const dynamic = "force-dynamic"; // never cache at the RSC layer

export default async function DashboardPage() {
  let initialSites: SiteResponse[] = [];
  let initialCursor: string | null = null;
  let fetchError: string | null = null;

  try {
    const result = await getSitesList(50);
    initialSites = result.data;
    initialCursor = result.next_cursor;
  } catch (err) {
    initialSites = [];
    fetchError =
      err instanceof ApiClientError ? `${err.code}: ${err.message}` : "Failed to load sites";
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Sites</h2>
          <p className="mt-1 text-sm text-gray-500">
            Emissions monitoring across all sites. Metrics refresh every 5 seconds.
          </p>
        </div>
        <div className="flex gap-3">
          <a
            href="/sites/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Site
          </a>
          <a
            href="/ingest"
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Ingest Batch
          </a>
        </div>
      </div>

      {fetchError ? (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          <strong>Error loading sites:</strong> {fetchError}
        </div>
      ) : (
        <SitesTable initialSites={initialSites} initialCursor={initialCursor} />
      )}
    </div>
  );
}
