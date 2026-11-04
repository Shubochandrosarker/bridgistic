import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, rollupOptions: { output: { manualChunks: { charts: ["recharts"], motion: ["framer-motion"], react: ["react", "react-dom", "react-router-dom"] } } } },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], globals: false },
});
