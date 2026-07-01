import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Installable, fully-offline PWA. The whole tool is client-side, so once
    // the shell, worker chunk, bundled fonts and the guide/navodila pages are
    // precached the app works with no network. Updates are user-driven
    // (registerType "prompt" + the PwaReloadPrompt toast) rather than a silent
    // reload — in-progress edit-mode changes are not persisted, so a surprise
    // reload would lose them.
    VitePWA({
      registerType: "prompt",
      // Keep the service worker out of dev so `npm run dev` and the Playwright
      // e2e suite are never served stale, SW-cached assets.
      devOptions: { enabled: false },
      includeAssets: ["favicon.svg", "robots.txt", "icons/*.png"],
      workbox: {
        // Precache the app shell, the gedcom.worker chunk, the bundled IBM Plex
        // woff2 fonts, and the multi-page guide/index.html + navodila/index.html
        // outputs → every page works offline.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // Root navigations fall back to the app shell; the standalone guide
        // pages are precached, so keep them off the fallback.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/guide\//, /^\/navodila\//],
      },
      manifest: {
        name: "GED Merge — GEDCOM merge, compare & edit",
        short_name: "GED Merge",
        description:
          "Merge, compare and edit GEDCOM genealogy files side-by-side — resolve conflicts field by field, normalize places and dates, and find duplicates. Free, private, 100% in-browser.",
        lang: "en",
        categories: ["utilities", "productivity"],
        theme_color: "#151310",
        background_color: "#151310",
        display: "standalone",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
    }),
  ],
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
