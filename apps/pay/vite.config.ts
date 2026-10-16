import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  build: { outDir: "dist", rollupOptions: { input: { main: resolve(__dirname, "index.html"), privacy: resolve(__dirname, "privacy.html"), terms: resolve(__dirname, "terms.html"), refund: resolve(__dirname, "refund.html") } } },
  test: { environment: "jsdom" },
});
