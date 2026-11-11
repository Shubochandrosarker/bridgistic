import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vite 8 (Rolldown) accepts only the function form of manualChunks.
const CHUNKS: Record<string, string[]> = {
  charts: ["recharts"],
  motion: ["framer-motion"],
  react: ["react", "react-dom", "react-router-dom", "react-router", "scheduler"],
};
function chunkFor(id: string): string | undefined {
  const m = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (!m) return undefined;
  for (const [name, pkgs] of Object.entries(CHUNKS)) if (pkgs.includes(m[1] ?? "")) return name;
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, rollupOptions: { output: { manualChunks: chunkFor } } },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], globals: false },
});
