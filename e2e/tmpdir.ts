import { mkdirSync } from "fs";
import os from "os";
import path from "path";

/**
 * A scratch directory this worker has to itself.
 *
 * Playwright loads a spec file once **per worker process**, so the fixtures
 * written at a spec's module scope are written again by every worker that runs
 * any test from that file — over the same path, at any moment. A browser in one
 * worker reading a file while another worker truncates and rewrites it fails
 * the read outright (`NotReadableError`), and the load it belonged to never
 * finished: the suite saw it as a wait for `.edit-person` timing out, minutes
 * later, in a spec that had nothing to do with it.
 *
 * Giving each worker its own directory means no two of them ever hold the same
 * path. Under `--repeat-each` a worker rewrites its own files between runs,
 * which is sequential and safe.
 */
export function tmpdir(): string {
  const id = process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? String(process.pid);
  const dir = path.join(os.tmpdir(), `ged-merge-e2e-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
