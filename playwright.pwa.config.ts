import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * The service-worker specs (`e2e/pwa/*.pwa.ts`). The service worker is kept out
 * of the dev server on purpose (vite.config.ts: `devOptions.enabled: false`),
 * so these run against the production build under `vite preview`, on a port of
 * their own. Run `npm run build` first; `npm run test:e2e:pwa` does both.
 *
 * Preview serves a *copy* of dist/, which the update spec rewrites to stand in
 * for a new deploy — dist/ itself is never touched.
 */
const PORT = Number(process.env.PWA_PORT ?? 5191);
export const PWA_DIST = path.join(os.tmpdir(), `ged-merge-pwa-dist-${PORT}`);

export default defineConfig({
  ...base,
  testDir: "./e2e/pwa",
  testMatch: "**/*.pwa.ts",
  // One server, one copy of the build that the update spec rewrites: the
  // tests must not run side by side.
  fullyParallel: false,
  workers: 1,
  use: { ...base.use, baseURL: `http://localhost:${PORT}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf "${PWA_DIST}" && cp -R dist "${PWA_DIST}" && npx vite preview --outDir "${PWA_DIST}" --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
