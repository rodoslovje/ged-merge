import { cpus, loadavg } from "node:os";
import { defineConfig, devices } from "@playwright/test";

/**
 * How many workers this machine can actually spare, right now.
 *
 * Playwright's default is half the cores and assumes it owns the machine. It
 * doesn't: a Vite dev server transpiles alongside the run, and on this machine
 * other sessions are frequently running their own suites. Oversubscribing does
 * not make the suite finish sooner — measured on a 10-core machine under a load
 * average of 65, five workers and two workers both took ~2.8 minutes, while the
 * *individual* tests ran three times faster with two (a scroll-loop test that
 * needed 21 s at five workers needed 7 s at two). The wall clock is the same
 * because a few long whole-file scans dominate it; what changes is how close
 * every test runs to its timeout.
 *
 * So: take half of what is *free*, never fewer than 2, never more than
 * Playwright's own default. An idle machine still gets the full complement.
 */
function spareWorkers(): number {
  const cores = cpus().length;
  const idle = Math.max(0, cores - loadavg()[0]); // 1-minute run-queue average
  return Math.max(2, Math.min(Math.floor(cores / 2), Math.floor(idle / 2)));
}

/**
 * The suite runs on a developer machine that is doing other things at the same
 * time — several dev servers, other agents' test runs, a browser — so the
 * budgets here are set for a *contended* machine, not an idle one. A test that
 * passes in 3 seconds idle can take five times that when the cores are
 * oversubscribed, and the failure it produces ("Timeout of 30000ms exceeded")
 * says nothing about the app.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",

  /**
   * Per-test budget. Playwright's default is 30 s, which several specs already
   * overrun *by declaration*: the whole-file tool scans wait on their result
   * row with `{ timeout: 120000 }`, the file loads with 60 s, and inside a 30 s
   * test none of those numbers could ever be reached — the test died at 30 s
   * whatever it was waiting for. 90 s is above every declared inner wait except
   * the deliberate 120/180 s ones, which raise the budget themselves.
   */
  timeout: 90_000,

  expect: {
    /**
     * Default is 5 s. Almost every assertion here follows a click that the app
     * answers with a re-render of a large list, and under load a frame can
     * take the better part of a second. 15 s costs nothing when the app is
     * quick (the assertion resolves as soon as it is true) and absorbs a
     * stalled frame when it isn't.
     */
    timeout: 15_000,
  },

  /**
   * A timeout under load is not a defect, and re-running the one test that hit
   * it is much cheaper than re-running the suite by hand. Failures that survive
   * a retry are the ones worth reading. Kept on locally too — the load this
   * suite is losing to is a local phenomenon.
   */
  retries: 2,

  /** CI runners are 2-core and shared; locally, whatever the machine can spare
   *  at the moment the run starts (see {@link spareWorkers}). */
  workers: process.env.CI ? 2 : spareWorkers(),

  use: {
    baseURL: "http://localhost:5180",
    /**
     * `retain-on-failure` records a trace for *every* test and throws it away
     * when the test passes — overhead paid on the whole suite for the few
     * traces anyone reads. With retries in place, the first retry is the
     * natural place to start recording.
     */
    trace: "on-first-retry",
    /**
     * An action that has not resolved in 30 s is stuck, not slow — fail it
     * inside the test's own budget, where the error names the action, instead
     * of letting it run out the whole 90 s and report only the test.
     */
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: {
    command: "npm run dev -- --port 5180 --strictPort",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    /** Vite's cold start pulls the dep graph through esbuild; on a loaded
     *  machine that is well past the 60 s default. */
    timeout: 180_000,
  },
});
