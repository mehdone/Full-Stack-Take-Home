import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://emissions:emissions@localhost:5432/emissions",
  },
  strict: true,
  verbose: true,
} satisfies Config;
