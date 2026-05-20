"use client";

/**
 * IngestForm — the load-bearing retry UX component.
 *
 * BATCH_ID LIFECYCLE (core idempotency contract):
 * 1. Generated once with crypto.randomUUID() when the component first mounts
 *    (lazy initial state: `useState(() => crypto.randomUUID())`).
 * 2. Stored in component state — never in a ref, never in URL, never in
 *    localStorage. It exists only for this form session.
 * 3. On SUBMIT: the same batchId is sent to POST /ingest.
 * 4. On 5xx / network failure: the UI shows a "Retry" button. Clicking Retry
 *    calls the SAME submit function with the SAME batchId and the SAME payload
 *    (payload is captured in a ref before the first attempt).
 * 5. On 4xx (VALIDATION_FAILED, CONFLICT, etc.): non-retryable. Field errors
 *    are shown. The user must fix the payload and click Submit, which generates
 *    a NEW batchId (because the previous payload was rejected, a new attempt is
 *    semantically a new batch).
 * 6. On 202 success: success toast shown, form clears, NEW batchId generated.
 * 7. "Start Over" button: clears everything and generates a NEW batchId
 *    explicitly, per Entry 9.4 spec.
 *
 * This component also fetches the site list for the dropdown (client-side,
 * once on mount). Sites rarely change so no poll is needed here.
 */

import { ApiClientError, getSitesList, ingestBatch } from "@/lib/api";
import type { IngestBatchInput, SiteResponse } from "@highwood/contracts";
import { IngestBatchSchema } from "@highwood/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeasurementRow {
  id: string; // local key for React reconciliation
  emission_point: string;
  recorded_at_local: string; // datetime-local value (string)
  value_kg_co2e: string;
}

type SubmitStatus =
  | { type: "idle" }
  | { type: "submitting" }
  | { type: "retryable_error"; message: string }
  | { type: "field_error"; fieldErrors: Record<string, string>; globalMessage: string }
  | { type: "success"; batchId: string; count: number };

function newRow(): MeasurementRow {
  return {
    id: crypto.randomUUID(),
    emission_point: "",
    recorded_at_local: "",
    value_kg_co2e: "",
  };
}

function localToEpochMilliseconds(localDatetime: string): number {
  // datetime-local gives "YYYY-MM-DDTHH:mm" — parse as local time
  const date = new Date(localDatetime);
  return date.getTime();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IngestForm() {
  // batch_id: generated once on mount, reused across retries
  const [batchId, setBatchId] = useState<string>(() => crypto.randomUUID());

  const [sites, setSites] = useState<SiteResponse[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState("");

  const [rows, setRows] = useState<MeasurementRow[]>([newRow()]);
  const [status, setStatus] = useState<SubmitStatus>({ type: "idle" });

  // Captures the payload of the most recent attempt so Retry can re-submit
  // the exact same data without re-reading the form. Only set on first submit;
  // cleared on success or "Start Over".
  const pendingPayload = useRef<IngestBatchInput | null>(null);

  // Load sites once on mount
  useEffect(() => {
    getSitesList(200)
      .then((res) => {
        setSites(res.data);
        if (res.data.length > 0 && res.data[0]) {
          setSelectedSlug(res.data[0].slug);
        }
      })
      .catch(() => {
        /* leave sites empty — user will see empty dropdown */
      })
      .finally(() => setSitesLoading(false));
  }, []);

  // ---------------------------------------------------------------------------
  // Submit logic
  // ---------------------------------------------------------------------------

  const submit = useCallback(async (payload: IngestBatchInput) => {
    setStatus({ type: "submitting" });
    try {
      const result = await ingestBatch(payload);
      pendingPayload.current = null;
      setStatus({
        type: "success",
        batchId: result.batch_id,
        count: result.measurements_received,
      });
      // Fresh form for the next entry
      setRows([newRow()]);
      setBatchId(crypto.randomUUID());
    } catch (err) {
      if (err instanceof ApiClientError && !err.isRetryable) {
        // 4xx — non-retryable; show errors and force a new batchId
        const fieldErrors = extractFieldErrors(err.details);
        setStatus({
          type: "field_error",
          fieldErrors,
          globalMessage: `${err.code}: ${err.message}`,
        });
        // A rejected payload is a new submission; generate a new batch_id
        // so the next attempt isn't confused with the rejected one.
        pendingPayload.current = null;
        setBatchId(crypto.randomUUID());
      } else {
        // 5xx / network — retryable; keep batchId and payload
        const message =
          err instanceof ApiClientError
            ? `${err.message} (HTTP ${err.status})`
            : err instanceof Error
              ? err.message
              : "Network error";
        setStatus({ type: "retryable_error", message });
      }
    }
  }, []);

  function handleFirstSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Dismiss previous status
    setStatus({ type: "idle" });

    // Build the raw payload from form state
    const measurements = rows.map((r) => ({
      emission_point: r.emission_point,
      recorded_at_ms: r.recorded_at_local ? localToEpochMilliseconds(r.recorded_at_local) : 0,
      value_kg_co2e: r.value_kg_co2e,
    }));

    const raw = {
      batch_id: batchId,
      site_slug: selectedSlug,
      measurements,
    };

    // Client-side validation with the shared Zod schema
    const parsed = IngestBatchSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = extractFieldErrors(parsed.error.errors);
      setStatus({
        type: "field_error",
        fieldErrors,
        globalMessage: "Please fix the errors below.",
      });
      return;
    }

    pendingPayload.current = parsed.data;
    void submit(parsed.data);
  }

  function handleRetry() {
    if (!pendingPayload.current) return;
    void submit(pendingPayload.current);
  }

  function handleStartOver() {
    pendingPayload.current = null;
    setRows([newRow()]);
    setSelectedSlug(sites[0]?.slug ?? "");
    setStatus({ type: "idle" });
    // Generate a fresh batchId — user explicitly chose to start a new batch
    setBatchId(crypto.randomUUID());
  }

  // ---------------------------------------------------------------------------
  // Row management
  // ---------------------------------------------------------------------------

  function updateRow(id: string, field: keyof Omit<MeasurementRow, "id">, value: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isSubmitting = status.type === "submitting";
  const fieldErrors = status.type === "field_error" ? status.fieldErrors : {};

  if (status.type === "success") {
    return (
      <div className="rounded-lg bg-green-50 p-6">
        <p className="font-medium text-green-800">Batch queued successfully.</p>
        <p className="mt-1 text-sm text-green-700">
          batch_id: <span className="font-mono">{status.batchId}</span> — {status.count}{" "}
          measurement(s) received.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={handleStartOver}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Batch
          </button>
          <a
            href="/"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleFirstSubmit(e)} className="space-y-6">
      {/* Retryable error banner */}
      {status.type === "retryable_error" && (
        <div className="rounded-md bg-yellow-50 px-4 py-3">
          <p className="text-sm font-medium text-yellow-800">
            Submit failed — you can retry with the same batch ID.
          </p>
          <p className="mt-1 text-xs text-yellow-700">{status.message}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={handleRetry}
              className="rounded-md bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={handleStartOver}
              className="rounded-md border border-yellow-400 px-4 py-2 text-sm font-medium text-yellow-800 hover:bg-yellow-100"
            >
              Start Over
            </button>
          </div>
        </div>
      )}

      {/* Non-retryable (4xx) error banner */}
      {status.type === "field_error" && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="font-medium">{status.globalMessage}</p>
          <p className="mt-1 text-xs text-red-600">
            A new batch ID has been generated. Fix the errors below and re-submit.
          </p>
        </div>
      )}

      {/* Site selector */}
      <div>
        <label htmlFor="site-slug" className="mb-1 block text-sm font-medium text-gray-700">
          Site
        </label>
        {sitesLoading ? (
          <p className="text-sm text-gray-400">Loading sites...</p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-red-500">
            No sites available.{" "}
            <a href="/sites/new" className="underline">
              Create one first.
            </a>
          </p>
        ) : (
          <select
            id="site-slug"
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            required
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {sites.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.slug} — {s.name}
              </option>
            ))}
          </select>
        )}
        {fieldErrors.site_slug && (
          <p className="mt-1 text-xs text-red-600">{fieldErrors.site_slug}</p>
        )}
      </div>

      {/* Measurement rows */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">
            Measurements ({rows.length}/100)
          </span>
          <button
            type="button"
            onClick={addRow}
            disabled={rows.length >= 100}
            className="text-xs text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Add row
          </button>
        </div>

        <div className="space-y-3">
          {rows.map((row, idx) => (
            <MeasurementRowEditor
              key={row.id}
              row={row}
              index={idx}
              fieldErrors={fieldErrors}
              onUpdate={updateRow}
              onRemove={() => removeRow(row.id)}
              canRemove={rows.length > 1}
            />
          ))}
        </div>

        {fieldErrors.measurements && (
          <p className="mt-2 text-xs text-red-600">{fieldErrors.measurements}</p>
        )}
      </div>

      {/* Submit controls + batch_id display */}
      <div>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting || sitesLoading || sites.length === 0}
            className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? "Submitting..." : "Submit Batch"}
          </button>
          <button
            type="button"
            onClick={handleStartOver}
            className="rounded-md border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Start Over
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          batch_id: <span className="font-mono">{batchId}</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-400">
          This ID is stable across retries. If a retry succeeds, duplicate measurements are
          automatically discarded by the backend.
        </p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// MeasurementRowEditor sub-component
// ---------------------------------------------------------------------------

interface RowEditorProps {
  row: MeasurementRow;
  index: number;
  fieldErrors: Record<string, string>;
  onUpdate: (id: string, field: keyof Omit<MeasurementRow, "id">, value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}

function MeasurementRowEditor({
  row,
  index,
  fieldErrors,
  onUpdate,
  onRemove,
  canRemove,
}: RowEditorProps) {
  const prefix = `measurements.${index}`;
  const epError = fieldErrors[`${prefix}.emission_point`] ?? fieldErrors.emission_point;
  const tsError = fieldErrors[`${prefix}.recorded_at_ms`] ?? fieldErrors.recorded_at_ms;
  const valError = fieldErrors[`${prefix}.value_kg_co2e`] ?? fieldErrors.value_kg_co2e;

  const epId = `${row.id}-ep`;
  const tsId = `${row.id}-ts`;
  const valId = `${row.id}-val`;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr_auto] gap-3 rounded-md border border-gray-200 bg-white p-3 shadow-sm">
      <div>
        <label htmlFor={epId} className="mb-0.5 block text-xs font-medium text-gray-600">
          Emission Point
        </label>
        <input
          id={epId}
          type="text"
          value={row.emission_point}
          onChange={(e) => onUpdate(row.id, "emission_point", e.target.value)}
          placeholder="EP-01"
          required
          className={inputCls(!!epError)}
        />
        {epError && <p className="mt-0.5 text-xs text-red-600">{epError}</p>}
      </div>

      <div>
        <label htmlFor={tsId} className="mb-0.5 block text-xs font-medium text-gray-600">
          Recorded At
        </label>
        <input
          id={tsId}
          type="datetime-local"
          value={row.recorded_at_local}
          onChange={(e) => onUpdate(row.id, "recorded_at_local", e.target.value)}
          required
          className={inputCls(!!tsError)}
        />
        {tsError && <p className="mt-0.5 text-xs text-red-600">{tsError}</p>}
      </div>

      <div>
        <label htmlFor={valId} className="mb-0.5 block text-xs font-medium text-gray-600">
          Value (kg CO2e)
        </label>
        <input
          id={valId}
          type="text"
          value={row.value_kg_co2e}
          onChange={(e) => onUpdate(row.id, "value_kg_co2e", e.target.value)}
          placeholder="12.345678"
          required
          pattern="^\d{1,12}(\.\d{1,6})?$"
          className={inputCls(!!valError)}
        />
        {valError && <p className="mt-0.5 text-xs text-red-600">{valError}</p>}
      </div>

      <div className="flex items-end pb-0.5">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          title="Remove row"
          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            role="img"
          >
            <title>Remove row</title>
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ZodIssueLike {
  path?: (string | number)[];
  message: string;
}

function extractFieldErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) return {};
  const errors: Record<string, string> = {};
  for (const issue of details as ZodIssueLike[]) {
    const path = issue.path?.join(".");
    if (path && !errors[path]) {
      errors[path] = issue.message;
    }
  }
  return errors;
}

function inputCls(hasError: boolean): string {
  return [
    "w-full rounded border px-2 py-1.5 text-sm shadow-sm",
    "focus:outline-none focus:ring-1",
    hasError ? "border-red-400 focus:ring-red-400" : "border-gray-300 focus:ring-blue-500",
  ].join(" ");
}
