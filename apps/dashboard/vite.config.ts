import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, rollupOptions: { output: { manualChunks(id: string) { if (id.includes("node_modules/recharts")) return "charts"; if (id.includes("node_modules/framer-motion")) return "motion"; if (/node_modules\/(react|react-dom|react-router-dom)\//.test(id)) return "react"; } } } },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], globals: false },
});
