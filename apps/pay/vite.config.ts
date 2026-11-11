import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  build: { outDir: "dist", rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } } },
  test: { environment: "jsdom" },
});
