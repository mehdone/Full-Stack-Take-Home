/**
 * Jest global setup: Configure test database.
 *
 * Tests expect a Postgres database to be running (e.g., via `pnpm infra:up`).
 * We run migrations here so each test suite starts with a clean schema.
 */

async function setup(): Promise<void> {
  // Assume DATABASE_URL is set in .env or the shell environment
  // Default to the docker-compose credentials if not set
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgresql://emissions:emissions@localhost:5432/emissions";
  }

  console.log("[Jest global setup] Using existing Postgres database");
  console.log("[Jest global setup] Run `pnpm infra:up` before running tests");
}

export default setup;
