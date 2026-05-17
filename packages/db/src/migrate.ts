import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Standalone migration runner. Reads DATABASE_URL from the environment, applies every
 * SQL file under ./migrations (drizzle-generated + hand-written, executed in numeric
 * order), then exits.
 */
async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://emissions:emissions@localhost:5432/emissions";

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "..", "migrations");

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(sql);

  console.log(`[db:migrate] applying migrations from ${migrationsFolder}`);
  try {
    await migrate(db, { migrationsFolder });
    console.log("[db:migrate] done");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
