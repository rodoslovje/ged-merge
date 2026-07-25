import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Version shown in the footer and atop the /changelog page: the last commit
// date (yyyy-mm-dd), not the build time — a rebuild with no new commits keeps
// showing the same version.
function getAppVersion(): string {
  try {
    return execSync("git log -1 --format=%cd --date=format:%Y-%m-%d").toString().trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
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
        // and changelog pages are precached, so keep them off the fallback.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/guide\//, /^\/navodila\//, /^\/changelog\//, /^\/posodobitve\//],
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
      // Multi-page build: the app shell, plus static, crawlable /guide and
      // /changelog pages (no client-side router exists to serve them otherwise).
      input: {
        main: resolve(__dirname, "index.html"),
        guide: resolve(__dirname, "guide/index.html"),
        // Slovenian translation of the guide, on a localized slug for SLO SEO.
        navodila: resolve(__dirname, "navodila/index.html"),
        changelog: resolve(__dirname, "changelog/index.html"),
        // Slovenian translation of the changelog, on a localized slug for SLO SEO.
        posodobitve: resolve(__dirname, "posodobitve/index.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Measure only the pure-logic layers. The UI / worker / persistence
      // layers are exercised by the Playwright e2e suite, not unit tests, so
      // instrumenting them here would just report misleading zeros.
      // Keep this list in sync with the pure-logic directories under src/ —
      // a renamed directory left behind here silently drops it from the gate
      // (as `src/tree/**` did after it became `src/chart/**`).
      include: [
        "src/chart/**/*.ts",
        "src/csv/**/*.ts",
        "src/edit-state/**/*.ts",
        "src/gedcom/**/*.ts",
        "src/geo/**/*.ts",
        "src/keyboard/**/*.ts",
        "src/match/**/*.ts",
        "src/merge/**/*.ts",
        "src/normalize/**/*.ts",
        "src/report/**/*.ts",
        "src/review/**/*.ts",
        "src/state/**/*.ts",
        "src/tools/**/*.ts",
      ],
      // `use*.ts` are React hooks living beside the pure modules they wrap
      // (e.g. edit-state/useDirtyTracking over edit-state/dirty) — same
      // rationale as the UI layer above: e2e covers them, unit coverage
      // would report misleading zeros.
      exclude: ["**/*.test.ts", "src/**/types.ts", "src/**/*.d.ts", "src/**/use*.ts"],
      // `text` (per-file) alongside the summary, so a gap in one module is
      // visible in CI output instead of being averaged away by its directory.
      reporter: ["text", "text-summary", "html"],
      // Per-directory floors — a regression ratchet, set a few points below the
      // current numbers so a genuine drop fails CI without flaking on small
      // edits. Re-run `npm run test:coverage` and raise these as coverage grows.
      thresholds: {
        "src/chart/**": { statements: 86, branches: 73, functions: 89, lines: 88 },
        "src/csv/**": { statements: 93, branches: 78, functions: 95, lines: 96 },
        "src/edit-state/**": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/gedcom/**": { statements: 76, branches: 68, functions: 77, lines: 80 },
        "src/geo/**": { statements: 76, branches: 71, functions: 69, lines: 80 },
        "src/keyboard/**": { statements: 87, branches: 70, functions: 62, lines: 86 },
        "src/match/**": { statements: 85, branches: 75, functions: 87, lines: 90 },
        "src/merge/**": { statements: 75, branches: 66, functions: 78, lines: 80 },
        "src/normalize/**": { statements: 90, branches: 81, functions: 87, lines: 92 },
        "src/report/**": { statements: 88, branches: 78, functions: 92, lines: 92 },
        "src/review/**": { statements: 83, branches: 79, functions: 80, lines: 87 },
        "src/state/**": { statements: 85, branches: 71, functions: 95, lines: 84 },
        "src/tools/**": { statements: 77, branches: 69, functions: 81, lines: 83 },
      },
    },
  },
});
