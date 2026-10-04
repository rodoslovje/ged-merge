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
        navigateFallbackDenylist: [
          /^\/guide\//,
          /^\/navodila\//,
          /^\/changelog\//,
          /^\/posodobitve\//,
          /^\/privacy\//,
          /^\/zasebnost\//,
          /^\/terms\//,
          /^\/pogoji\//,
        ],
      },
      manifest: {
        name: "GED Merge — GEDCOM merge, compare & edit",
        short_name: "GED Merge",
        description:
          "The GEDCOM workbench in your browser: edit your family tree, see it as charts and maps, clean it with maintenance tools, and merge other researchers' files person by person. Free, no account — your file is never uploaded.",
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
      // Multi-page build: the app shell, plus static, crawlable /guide,
      // /changelog and legal pages (no client-side router exists to serve them
      // otherwise). The legal pages are static rather than an in-app modal so
      // they have a durable, linkable, printable address — and so their text
      // lives in exactly one place per language.
      input: {
        main: resolve(__dirname, "index.html"),
        guide: resolve(__dirname, "guide/index.html"),
        // Slovenian translation of the guide, on a localized slug for SLO SEO.
        navodila: resolve(__dirname, "navodila/index.html"),
        changelog: resolve(__dirname, "changelog/index.html"),
        // Slovenian translation of the changelog, on a localized slug for SLO SEO.
        posodobitve: resolve(__dirname, "posodobitve/index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        // Slovenian legal pages, on localized slugs like the guide/changelog.
        zasebnost: resolve(__dirname, "zasebnost/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        pogoji: resolve(__dirname, "pogoji/index.html"),
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
      // edits. Re-run `npm run test:coverage` and raise these as coverage grows
      // (last ratcheted 2026-09-18). `src/keyboard` is tiny (~40 statements),
      // so its floors sit further below: one uncovered branch moves it 8 points.
      thresholds: {
        "src/chart/**": { statements: 90, branches: 77, functions: 91, lines: 92 },
        "src/csv/**": { statements: 92, branches: 81, functions: 95, lines: 95 },
        "src/edit-state/**": { statements: 95, branches: 91, functions: 97, lines: 95 },
        "src/gedcom/**": { statements: 90, branches: 82, functions: 93, lines: 92 },
        "src/geo/**": { statements: 87, branches: 80, functions: 84, lines: 90 },
        "src/keyboard/**": { statements: 80, branches: 75, functions: 75, lines: 82 },
        "src/match/**": { statements: 90, branches: 86, functions: 93, lines: 93 },
        "src/merge/**": { statements: 87, branches: 79, functions: 89, lines: 90 },
        "src/normalize/**": { statements: 91, branches: 84, functions: 90, lines: 93 },
        "src/report/**": { statements: 91, branches: 82, functions: 97, lines: 94 },
        "src/review/**": { statements: 89, branches: 85, functions: 91, lines: 91 },
        "src/state/**": { statements: 86, branches: 81, functions: 97, lines: 89 },
        "src/tools/**": { statements: 90, branches: 82, functions: 91, lines: 94 },
      },
    },
  },
});
