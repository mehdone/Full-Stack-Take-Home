/**
 * Test helper: Creates a bootstrapped NestJS app with a Testcontainers Postgres database.
 *
 * Usage:
 *   const app = await createTestApp();
 *   const server = app.getHttpServer();
 *   await app.close();
 *
 * The helper:
 * 1. Sets DATABASE_URL to the global test container
 * 2. Runs migrations automatically
 * 3. Returns a fully-initialized INestApplication
 * 4. Provides a truncation helper to clean state between tests
 */

import { dirname, resolve } from "node:path";
import type { DbClient } from "@highwood/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { AppModule } from "../../src/app.module.ts";
import { DB_CLIENT } from "../../src/db/db.tokens.ts";

let migrationRun = false;

export async function createTestApp(): Promise<INestApplication> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set in test environment");
  }

  // Run migrations once per test worker
  if (!migrationRun) {
    await runMigrations(databaseUrl);
    migrationRun = true;
  }

  // Create NestJS app with test container's database URL
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  return app;
}

/**
 * Truncate tables between tests to avoid state leakage.
 * Order matters: truncate dependent tables first.
 * As we add more tables (measurements, outbox, etc.), extend this list.
 *
 * Phase 3: Only sites table exists.
 * Phase 4+: Add measurements, site_emission_points, outbox in order.
 */
export async function truncateTables(dbClient: DbClient): Promise<void> {
  // List tables in truncate order (parents before children, preserving FK constraints)
  const tables = ["sites"];

  try {
    for (const table of tables) {
      await dbClient.sql`TRUNCATE ${dbClient.sql(table)} RESTART IDENTITY CASCADE`;
    }
  } catch (err) {
    console.error("Error truncating tables:", err);
    throw err;
  }
}

/**
 * Internal: Run migrations via drizzle-orm migrator.
 */
async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
  });

  try {
    // Wait a moment for the container to be fully ready
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const db = drizzle(sql);

    // Resolve migrations folder correctly for Jest
    // process.cwd() in Jest is the workspace app directory (apps/api)
    // Migrations are at ../../packages/db/migrations from the app root
    const migrationsFolder = resolve(process.cwd(), "..", "..", "packages", "db", "migrations");

    console.log(`[test-app] Applying migrations from ${migrationsFolder}`);
    await drizzleMigrate(db, { migrationsFolder });
    console.log("[test-app] Migrations complete successfully");
  } catch (err) {
    console.error("[test-app] Migration failed:", err);
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Helper to get the DB_CLIENT provider from the app for truncation/queries.
 */
export function getDbClient(app: INestApplication): DbClient {
  return app.get(DB_CLIENT);
}
