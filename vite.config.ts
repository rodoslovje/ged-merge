import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Use relative base so the static build can be hosted from any subpath
  // (GitHub Pages project sites, etc.).
  base: "./",
  build: {
    rollupOptions: {
      // Multi-page build: the app shell, plus a static, crawlable /guide
      // page for SEO (no client-side router exists to serve it otherwise).
      input: {
        main: resolve(__dirname, "index.html"),
        guide: resolve(__dirname, "guide/index.html"),
        // Slovenian translation of the guide, on a localized slug for SLO SEO.
        navodila: resolve(__dirname, "navodila/index.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
