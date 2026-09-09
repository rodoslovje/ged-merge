import { defineConfig } from "vitest/config";

/**
 * Runner config for the matching benchmark (`scripts/match-bench.ts`), which
 * needs the app's TypeScript module graph but is not a unit test: it reads the
 * real files under `test-data/` and compares the result against a stored
 * baseline. Run it with
 *
 *   npx vitest run --config scripts/match-bench.config.ts --reporter=verbose
 *
 * The normal `npm test` never picks it up (its include is `src/**\/*.test.ts`).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/match-bench.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    // One file, run sequentially — the point is comparable timings.
    fileParallelism: false,
  },
});
