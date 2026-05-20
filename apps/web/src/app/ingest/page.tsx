/**
 * Ingest page — Server Component (shell only).
 * The form itself is a Client Component because it owns batch_id state,
 * measurement rows state, and the retry logic.
 */

import { IngestForm } from "@/components/IngestForm";

export const metadata = { title: "Ingest Batch | Highwood Emissions" };

export default function IngestPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Manual Ingestion</h2>
        <p className="mt-1 text-sm text-gray-500">
          Submit emission measurements for a site. The batch ID is stable across retries so
          duplicate measurements are never counted twice.
        </p>
      </div>
      <IngestForm />
    </div>
  );
}
