import { expect, type Page } from "@playwright/test";

// Shared helpers for specs that exercise the IndexedDB workspace cache
// (persistence.spec.ts, main-reload.spec.ts).

type CacheQuery = { mainContains?: string; decisions?: boolean; compare?: boolean };

/** In-page check (serialized into the page, so it references nothing outside
 *  itself): does the cache hold every artifact `opts` asks for? */
function cacheMatches(opts: CacheQuery): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = indexedDB.open("gedmerge-session");
    // No database yet: abort the upgrade rather than create an empty v1
    // database, which the app (also at v1) would then open without its stores.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => {
      const db = req.result;
      const get = (store: string, key: string) =>
        new Promise<unknown>((res) => {
          try {
            const r = db.transaction(store, "readonly").objectStore(store).get(key);
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(undefined);
          } catch {
            res(undefined); // stores not created yet
          }
        });
      void (async () => {
        const session = (await get("session", "current")) as { decisions?: unknown[] } | undefined;
        const main = (await get("files", "main")) as { blob?: Blob } | undefined;
        const compare = await get("files", "compare");
        if (opts.decisions && !(session && Array.isArray(session.decisions) && session.decisions.length > 0)) return resolve(false);
        if (opts.compare && !compare) return resolve(false);
        if (opts.mainContains) {
          if (!main?.blob) return resolve(false);
          const text = await main.blob.text();
          if (!text.includes(opts.mainContains)) return resolve(false);
        }
        resolve(true);
      })();
    };
    req.onerror = () => resolve(false);
  });
}

// The persistence writer is debounced and its writes span two IndexedDB stores,
// so a fixed delay is unreliable. Wait for the exact artifacts a reload restore
// depends on to be durably readable: for edits, the main blob must actually
// contain the edited text; for merges, the session must hold decisions and the
// compare file must be cached. Polling those directly avoids the race where the
// session record appears before the (separately written) main blob is visible.
export async function waitForCache(page: Page, opts: CacheQuery) {
  await page.waitForFunction(cacheMatches, opts, { timeout: 15000 });
  // Chromium defers flushing IndexedDB to disk briefly; a reload within ~1s of
  // the write can lose it (a real user never reloads that fast, and the
  // unsaved-changes prompt guards them). The flush gives the page no signal to
  // wait on, so this one margin stays a duration.
  await page.waitForTimeout(1500);
}

/** The writer's debounce (`useWorkspacePersistence`, 800 ms). */
const PERSIST_DEBOUNCE_MS = 800;

/**
 * Asserts that the cache does NOT come to hold `opts`. "Nothing happens" can
 * only be checked over a bounded time: the cache is sampled repeatedly and the
 * check passes once it has stayed without `opts` for well past the writer's
 * debounce. A write at any point makes every later sample fail, so the
 * retrying block runs out its timeout and the test fails with the reason.
 */
export async function expectNotCached(page: Page, opts: CacheQuery) {
  const start = Date.now();
  await expect(async () => {
    expect(await page.evaluate(cacheMatches, opts), "the workspace was written to the cache").toBe(false);
    expect(Date.now() - start, "still inside the persistence debounce").toBeGreaterThan(PERSIST_DEBOUNCE_MS * 2);
  }).toPass({ intervals: [200], timeout: PERSIST_DEBOUNCE_MS * 2 + 5000 });
}

// Workspace caching is opt-in (off by default). Seed the settings blob before
// the app boots so it starts enabled — this also runs on reload. Seeding avoids
// the persistent-storage prompt path (only the in-app toggle requests it).
export async function enablePersist(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true }));
  });
}
