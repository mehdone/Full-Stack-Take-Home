import type { CreateSiteInput, SiteResponse } from "@highwood/contracts";
import type { DbClient } from "@highwood/db";
import { sites } from "@highwood/db";
import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { SITES_VALID_KEY } from "../bootstrap/bootstrap.service.ts";
import { DB_CLIENT } from "../db/db.tokens.ts";
import { REDIS_CLIENT } from "../redis/redis.tokens.ts";

/**
 * SitesService — write-path for site creation.
 *
 * The service owns the mapping between Drizzle row types and the SiteResponse
 * contract shape. datetime fields are serialised as ISO-8601 strings with offset
 * (Postgres returns JS Date objects; `.toISOString()` gives the UTC-offset form
 * the contract expects). latitude/longitude come back from Postgres as numeric
 * strings and are coerced to numbers here; emission_limit stays as the numeric
 * string Postgres returns (matches NumericKgSchema wire format).
 *
 * Coherence invariant with the ingest hot path (ARCHITECTURE.md §14):
 * `/ingest` trusts the Redis `sites:valid` SET as the sole source of truth
 * on cache hits. That trust is only safe if site creation guarantees the
 * cache is updated whenever the DB is. `create()` enforces that by performing
 * the DB INSERT and the SADD inside one Drizzle transaction — if the SADD
 * throws (e.g. Redis is down), the DB insert is rolled back. No phantom rows
 * that exist in Postgres but can't accept ingests.
 */
@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(params: CreateSiteInput): Promise<SiteResponse> {
    let row: typeof sites.$inferSelect;

    try {
      row = await this.db.db.transaction(async (tx) => {
        const rows = await tx
          .insert(sites)
          .values({
            slug: params.slug,
            name: params.name,
            country: params.country,
            state: params.state ?? null,
            city: params.city ?? null,
            postalCode: params.postal_code ?? null,
            latitude: String(params.latitude),
            longitude: String(params.longitude),
            timezone: params.timezone,
            emissionLimit: params.emission_limit,
          })
          .returning();

        const inserted = rows[0];
        if (!inserted) throw new Error("INSERT returned no rows");

        // SADD must succeed for the transaction to commit. If Redis is
        // unavailable, the whole site creation fails and the DB INSERT is
        // rolled back. This upholds the cache-as-authority invariant the
        // ingest path depends on: any slug present in `sites` is also in
        // `sites:valid`.
        await this.redis.sadd(SITES_VALID_KEY, inserted.slug);

        return inserted;
      });
    } catch (err: unknown) {
      if (isPostgresUniqueViolation(err)) {
        throw new ConflictException({
          message: "site with this slug already exists",
          details: { slug: params.slug },
        });
      }
      throw err;
    }

    this.logger.log({
      event: "site.created",
      slug: row.slug,
      name: row.name,
    });

    return rowToResponse(row);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToResponse(row: typeof sites.$inferSelect): SiteResponse {
  return {
    slug: row.slug,
    name: row.name,
    country: row.country,
    state: row.state ?? null,
    city: row.city ?? null,
    postal_code: row.postalCode ?? null,
    // Drizzle returns numeric columns as strings from postgres-js.
    // Coerce lat/lon to numbers to match SiteResponseSchema (z.number()).
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone,
    // emission_limit stays as a string — NumericKgSchema is z.string() on the wire.
    emission_limit: row.emissionLimit,
    // Date objects from Drizzle mode:"date" — serialize to ISO-8601 with Z offset.
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface PostgresError {
  code: string;
}

function isPostgresUniqueViolation(err: unknown): err is PostgresError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Record<string, unknown>).code === "23505"
  );
}
