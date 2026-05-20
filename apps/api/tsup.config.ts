import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  // ESM output: works with "type": "module" in package.json
  // Node 20 handles ESM natively; the output file becomes main.js
  format: ["esm"],
  target: "node20",
  bundle: true,
  // Inline workspace packages so the bundle is self-contained.
  // Production images only need node_modules for third-party deps.
  noExternal: ["@highwood/config", "@highwood/contracts", "@highwood/db"],
  outDir: "dist",
  clean: true,
  sourcemap: false,
  // NestJS decorators require class names to be preserved
  keepNames: true,
  esbuildOptions(options) {
    options.keepNames = true;
  },
});
