import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index.ts";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbClient {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

/**
 * Create a Drizzle client backed by postgres-js.
 *
 * The returned `db` is the query builder; `sql` is the raw postgres-js handle (useful
 * for migrations and raw SQL). Call `close()` on graceful shutdown.
 */
export function createClient(databaseUrl: string, options?: { max?: number }): DbClient {
  const sql = postgres(databaseUrl, {
    max: options?.max ?? 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
