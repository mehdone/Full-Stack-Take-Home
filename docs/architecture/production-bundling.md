# Production Bundling — `tsup`, `noExternal`, `@swc/core`

← Back to [`ARCHITECTURE.md`](../../ARCHITECTURE.md). This document expands §12.3.

## 1. The problem

`packages/db`, `packages/contracts`, and `packages/config` ship **TypeScript sources only** — no compiled `dist/`. Reasons:

- One source of truth, no double-edit / rebuild cycle.
- pnpm workspace symlinks let dev tooling (`tsx`, the test runner, the Next.js compiler) consume sources directly.
- Type inference is sharper when types come from source than from a `.d.ts`.

In **dev**, this is fine — every app runs via `tsx` (TypeScript runtime) and reads sources directly.

In **production**, the bundle must inline these packages, because a deployed Node image won't have the workspace symlink graph and the imports would fail at runtime with `Cannot find module '@highwood/db'`.

## 2. The solution: `tsup` + `noExternal`

Each deployable app has its own `tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: ["@highwood/contracts", "@highwood/db", "@highwood/config"],
  esbuildOptions(options) {
    options.define = { "require.resolve": undefined };
  },
});
```

`noExternal` tells `tsup` (which wraps `esbuild`) to inline these packages into the final bundle. Output: a single `dist/main.js` (ESM) containing the app's logic + all shared Zod schemas + all Drizzle types. No runtime dependency on `node_modules/@highwood/*`.

**Implication.** Every deployable app (`apps/api`, `apps/consumer`, `apps/outbox-relay`, `apps/system-alerts`, `apps/alerting`, `apps/etl`) must have its own `tsup.config.ts` with the same `noExternal` list. Forgetting one → `Cannot find module '@highwood/db'` at runtime in that app's image.

## 3. The `@swc/core` requirement

`tsup` uses `esbuild` under the hood. `esbuild` does **not** emit TypeScript decorator metadata by default. But NestJS depends on decorator metadata for dependency injection:

```ts
@Injectable()
export class SomeService {
  constructor(private db: DbClient) { }   // ← needs Reflect.metadata("design:paramtypes", [DbClient])
}
```

Without that metadata, NestJS cannot resolve the `DbClient` parameter at construction time and DI fails at startup with `Nest can't resolve dependencies of SomeService (?)`.

Fix: add `@swc/core` to devDependencies and let `tsup`'s SWC integration emit the decorator metadata:

```ts
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  // ... as above ...
  esbuildOptions(options) {
    options.define = { "require.resolve": undefined };
    // SWC is invoked by tsup's loader pipeline; the swc config in .swcrc handles metadata:
    //   { "jsc": { "parser": { "syntax": "typescript", "decorators": true },
    //              "transform": { "legacyDecorator": true, "decoratorMetadata": true } } }
  },
});
```

Already wired in `apps/api`; must be replicated for every NestJS deployable.

## 4. Image strategy

A minimal production Dockerfile per app:

```dockerfile
FROM node:22-alpine
WORKDIR /app

# The bundle inlines all @highwood/* packages, so we only need runtime deps
# that aren't bundled (rxjs, pino, postgres, zod, etc.).
COPY apps/api/dist/main.js /app/server.js
COPY apps/api/package.json /app/package.json
COPY node_modules /app/node_modules

EXPOSE 3000
CMD ["node", "server.js"]
```

Critically: **no `packages/db/src/` or `packages/contracts/src/`** needs to be in the image — they live inside `main.js`.

For a real production deploy, prefer a multi-stage build that runs `pnpm install --prod` for the runtime deps to keep the image lean. Out of scope here, but the bundling approach above is the prerequisite.

## 5. Verifying the bundle locally

```bash
pnpm --filter @highwood/api build         # produces apps/api/dist/main.js

# Sanity check: no @highwood/* imports in the bundle
grep -E "from ['\"]@highwood/" apps/api/dist/main.js  # should print nothing

# Sanity check: NestJS DI works at runtime
node apps/api/dist/main.js                # should boot, not throw "can't resolve dependencies"
```

If the second check fails with a "can't resolve dependencies" error, `@swc/core` is misconfigured.

If the first check prints lines, `noExternal` is missing an entry.

## 6. Why not `tsc --build` to a `dist/`?

Considered briefly. `tsc` emits per-file `.js` plus type declarations; deploying the result means shipping the entire `packages/*/dist/` graph alongside the app. That works, but:

- Triples the number of files in the image.
- Forces a build step on every shared package before any app can build.
- Loses the pnpm workspace's source-symlink ergonomics in CI.

`tsup` + `noExternal` is fewer moving parts and gives a single-file output that's trivial to deploy.
