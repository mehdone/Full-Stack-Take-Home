"use client";

/**
 * Client component: handles "Load more" cursor-based pagination.
 *
 * The initial page of sites is fetched server-side (see app/page.tsx) and
 * passed in as props. Subsequent pages are fetched client-side here. This
 * avoids a full page navigation for pagination while still giving the first
 * paint from the server.
 */

import { SiteMetricsRow } from "@/components/SiteMetricsRow";
import { getSitesList } from "@/lib/api";
import type { SiteResponse, SitesListResponse } from "@highwood/contracts";
import { useState } from "react";

interface Props {
  initialSites: SiteResponse[];
  initialCursor: string | null;
}

export function SitesTable({ initialSites, initialCursor }: Props) {
  const [sites, setSites] = useState<SiteResponse[]>(initialSites);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result: SitesListResponse = await getSitesList(50, cursor);
      setSites((prev) => [...prev, ...result.data]);
      setCursor(result.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more sites");
    } finally {
      setLoading(false);
    }
  }

  if (sites.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
        <p className="text-gray-500">No sites yet.</p>
        <a href="/sites/new" className="mt-3 inline-block text-sm text-blue-600 hover:underline">
          Create the first site
        </a>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Slug
              </th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Name
              </th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Location
              </th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Timezone
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                Limit (kg CO2e)
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                Total (kg CO2e)
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                Prior Months
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                Month-to-Date
              </th>
              <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                Compliance
              </th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <SiteMetricsRow key={site.slug} site={site} />
            ))}
          </tbody>
        </table>
      </div>

      {cursor && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
