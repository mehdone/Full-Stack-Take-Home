# Response Envelope — Wiring & Pipeline

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §8.1.

## 1. The request pipeline

Every request traverses the same five-stage chain regardless of which endpoint it lands on. The platform owns stages 1, 2, 3, and 5; the controller owns only stage 4. The exception filter is an alternate exit that catches anything thrown at any stage.

```
                 POST /sites { slug, name, country, ... }
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 1. RequestIdMiddleware                              │
   │    Reads x-request-id header or generates UUID;     │
   │    sets req.id; echoes header back on response.     │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 2. pino-http  (logs request line with request_id)   │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 3. ZodValidationPipe(CreateSiteSchema)              │
   │    safeParse the body. On failure: throw ZodError.  │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 4. Controller method  (SitesController.create)      │
   │    Returns plain object: SiteResponse.              │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ 5. ResponseInterceptor                              │
   │    Wraps return value: { ok: true, data: ... }.     │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
                  201 { ok: true, data: { ... } }


                  If anything threw at any stage:
                              │
                              ▼
   ┌─────────────────────────────────────────────────────┐
   │ AllExceptionsFilter                                 │
   │    ZodError       → 400 VALIDATION_FAILED           │
   │    HttpException  → status + matching code          │
   │    Postgres 23505 → 409 CONFLICT                    │
   │    other          → 500 INTERNAL + log stack        │
   │    All include request_id.                          │
   └─────────────────────────────────────────────────────┘
                              │
                              ▼
                  4xx/5xx { ok: false, error: { code, message, request_id } }
```

The shape of this pipeline is what makes the envelope guarantee **structural** rather than aspirational: controllers cannot accidentally skip validation, return an unwrapped body, or leak an unmapped error — those failure modes would require bypassing the framework, not just forgetting a line.

## 2. The `APP_FILTER` / `APP_INTERCEPTOR` provider pattern

Both globals are registered as `APP_FILTER` / `APP_INTERCEPTOR` **providers in `AppModule`**, not via `app.useGlobalFilters()` / `app.useGlobalInterceptors()` in `main.ts`.

```ts
// AppModule
providers: [
  { provide: APP_FILTER,      useClass: AllExceptionsFilter },
  { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
]
```

**Why this matters.** `useGlobalX()` only applies when `main.ts` runs the bootstrap. Jest integration tests that bootstrap `AppModule` directly with `Test.createTestingModule(...).compile()` would silently bypass the envelope and the filter — meaning the test suite would not actually be exercising the platform behavior the API ships. With the provider form, the filter and interceptor apply identically in every bootstrap context:

- `main.ts` bootstrap (prod / dev)
- Jest integration tests
- Hypothetical hybrid microservice bootstrap

This was a real bug surfaced during Phase 3 — tests passed against unwrapped responses. The provider form is the only correct pattern in a project that has both an HTTP bootstrap and a test bootstrap.

## 3. Error code → HTTP mapping

| Code | HTTP | Source |
|---|---|---|
| `VALIDATION_FAILED` | 400 | `ZodError` thrown by `ZodValidationPipe`, custom timezone validation, clock-skew rejection |
| `NOT_FOUND` | 404 | `NotFoundException`; health check when a downstream is unreachable |
| `CONFLICT` | 409 | `ConflictException`; Postgres unique violation (`23505`) caught as belt-and-suspenders |
| `RATE_LIMITED` | 429 | Reserved; placeholder enum for future rate limiting |
| `INTERNAL` | 500 | Anything else (full stack logged internally, message sanitized for the client) |

The filter extracts structured `{ message, details }` from `HttpException.getResponse()`, so services can throw `new ConflictException({ message, details })` and have both fields propagate without per-exception mapping.

## 4. `ZodValidationPipe` behavior

The pipe is generic over the schema:

```ts
@Post()
async create(@Body(new ZodValidationPipe(CreateSiteSchema)) dto: CreateSiteInput) { ... }
```

Internally it calls `schema.safeParse(value)`. On `success: false`, it throws a `ZodError`, which the filter formats into `details.issues` (a flat list of `{ path, code, message }`) in the error envelope. Clients can render field-level error messages without parsing free-form strings.

## 5. `request_id` propagation

UUID v7 (preferred) attached by `RequestIdMiddleware` very early in the lifecycle. Echoed:

- On `X-Request-Id` response header.
- In every pino log line bound to that request's context.
- In the `error.request_id` field on `4xx` / `5xx` responses.

End-to-end traceability: a customer who reports an error with their request ID can be matched 1:1 to the relevant log line.
