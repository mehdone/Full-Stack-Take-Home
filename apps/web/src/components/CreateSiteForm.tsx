"use client";

/**
 * Client component: Create Site form.
 *
 * Validation is done with a single safeParse call on submit against the shared
 * CreateSiteSchema from @highwood/contracts — no react-hook-form added. This
 * satisfies the constraint: hand-rolled state + safeParse if the library isn't
 * already a dep.
 *
 * On 4xx: shows field errors from error.details (not retryable).
 * On 5xx / network: shows error message (user can click Submit again).
 * On success: redirects to dashboard.
 */

import { ApiClientError, createSite } from "@/lib/api";
import { CreateSiteSchema } from "@highwood/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ZodIssue } from "zod";

const TIMEZONES = [
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "America/Edmonton",
  "Europe/London",
  "UTC",
];

interface FieldErrors {
  [field: string]: string;
}

function extractFieldErrors(details: unknown): FieldErrors {
  if (!Array.isArray(details)) return {};
  const errors: FieldErrors = {};
  for (const issue of details as ZodIssue[]) {
    const field = issue.path?.[0];
    if (typeof field === "string" && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

export function CreateSiteForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setGlobalError(null);
    setFieldErrors({});

    const fd = new FormData(e.currentTarget);
    const raw = {
      slug: fd.get("slug"),
      name: fd.get("name"),
      country: (fd.get("country") as string)?.toUpperCase(),
      state: fd.get("state") || undefined,
      city: fd.get("city") || undefined,
      postal_code: fd.get("postal_code") || undefined,
      latitude: Number(fd.get("latitude")),
      longitude: Number(fd.get("longitude")),
      timezone: fd.get("timezone"),
      emission_limit: fd.get("emission_limit"),
    };

    // Client-side validation with the shared Zod schema
    const parsed = CreateSiteSchema.safeParse(raw);
    if (!parsed.success) {
      setFieldErrors(extractFieldErrors(parsed.error.errors));
      return;
    }

    setSubmitting(true);
    try {
      await createSite(parsed.data);
      setSuccess(true);
      // Redirect after a brief moment so the user sees confirmation
      setTimeout(() => router.push("/"), 600);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (!err.isRetryable) {
          // 4xx — parse field errors from details
          const fe = extractFieldErrors(err.details);
          if (Object.keys(fe).length > 0) {
            setFieldErrors(fe);
          } else {
            setGlobalError(`${err.code}: ${err.message}`);
          }
        } else {
          setGlobalError(`Server error: ${err.message}. Please try again.`);
        }
      } else {
        setGlobalError("Unexpected error. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-lg bg-green-50 p-6 text-center text-green-800">
        <p className="font-medium">Site created successfully!</p>
        <p className="mt-1 text-sm text-green-600">Redirecting to dashboard...</p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
      {globalError && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{globalError}</div>
      )}

      <Field label="Slug" htmlFor="slug" error={fieldErrors.slug}>
        <input
          id="slug"
          name="slug"
          type="text"
          placeholder="well-pad-01"
          required
          className={inputCls(!!fieldErrors.slug)}
        />
        <p className="mt-1 text-xs text-gray-500">
          Lowercase, alphanumeric, hyphens allowed (3-64 chars)
        </p>
      </Field>

      <Field label="Name" htmlFor="name" error={fieldErrors.name}>
        <input
          id="name"
          name="name"
          type="text"
          placeholder="North Well Pad"
          required
          className={inputCls(!!fieldErrors.name)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Country" htmlFor="country" error={fieldErrors.country}>
          <input
            id="country"
            name="country"
            type="text"
            placeholder="US"
            pattern="[A-Za-z]{2}"
            maxLength={2}
            required
            className={inputCls(!!fieldErrors.country)}
          />
          <p className="mt-1 text-xs text-gray-500">ISO 3166-1 alpha-2 (e.g. US, CA, GB)</p>
        </Field>
        <Field label="State / Region (optional)" htmlFor="state" error={fieldErrors.state}>
          <input
            id="state"
            name="state"
            type="text"
            placeholder="Alberta"
            maxLength={100}
            className={inputCls(!!fieldErrors.state)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="City (optional)" htmlFor="city" error={fieldErrors.city}>
          <input
            id="city"
            name="city"
            type="text"
            placeholder="Edmonton"
            maxLength={100}
            className={inputCls(!!fieldErrors.city)}
          />
        </Field>
        <Field label="Postal Code (optional)" htmlFor="postal_code" error={fieldErrors.postal_code}>
          <input
            id="postal_code"
            name="postal_code"
            type="text"
            placeholder="T5J 0N3"
            maxLength={20}
            className={inputCls(!!fieldErrors.postal_code)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Latitude" htmlFor="latitude" error={fieldErrors.latitude}>
          <input
            id="latitude"
            name="latitude"
            type="number"
            step="any"
            min="-90"
            max="90"
            placeholder="51.5"
            required
            className={inputCls(!!fieldErrors.latitude)}
          />
        </Field>
        <Field label="Longitude" htmlFor="longitude" error={fieldErrors.longitude}>
          <input
            id="longitude"
            name="longitude"
            type="number"
            step="any"
            min="-180"
            max="180"
            placeholder="-114.1"
            required
            className={inputCls(!!fieldErrors.longitude)}
          />
        </Field>
      </div>

      <Field label="Timezone" htmlFor="timezone" error={fieldErrors.timezone}>
        <select id="timezone" name="timezone" required className={inputCls(!!fieldErrors.timezone)}>
          <option value="">Select timezone</option>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Emission Limit (kg CO2e)"
        htmlFor="emission_limit"
        error={fieldErrors.emission_limit}
      >
        <input
          id="emission_limit"
          name="emission_limit"
          type="text"
          placeholder="1000.00"
          pattern="^\d{1,12}(\.\d{1,6})?$"
          required
          className={inputCls(!!fieldErrors.emission_limit)}
        />
        <p className="mt-1 text-xs text-gray-500">
          Up to 12 integer + 6 fractional digits (e.g. 1000.50)
        </p>
      </Field>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create Site"}
        </button>
        <a
          href="/"
          className="rounded-md border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function inputCls(hasError: boolean) {
  return [
    "w-full rounded-md border px-3 py-2 text-sm shadow-sm",
    "focus:outline-none focus:ring-2",
    hasError ? "border-red-400 focus:ring-red-400" : "border-gray-300 focus:ring-blue-500",
  ].join(" ");
}
