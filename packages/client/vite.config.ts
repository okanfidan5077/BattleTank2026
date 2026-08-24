import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    fs: {
      // Allow serving files from the monorepo root (packages/shared/dist).
      allow: ["../.."],
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  // The linked workspace package is already ESM; let Vite read it as source.
  optimizeDeps: {
    exclude: ["@battletank/shared"],
  },
});
