import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node20",
  bundle: true,
  noExternal: ["@highwood/config", "@highwood/db"],
  outDir: "dist",
  clean: true,
  sourcemap: false,
  keepNames: true,
  esbuildOptions(options) {
    options.keepNames = true;
  },
});
