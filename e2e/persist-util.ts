import type { Page } from "@playwright/test";

// Shared helpers for specs that exercise the IndexedDB workspace cache
// (persistence.spec.ts, main-reload.spec.ts).

// The persistence writer is debounced and its writes span two IndexedDB stores,
// so a fixed delay is unreliable. Wait for the exact artifacts a reload restore
// depends on to be durably readable: for edits, the main blob must actually
// contain the edited text; for merges, the session must hold decisions and the
// compare file must be cached. Polling those directly avoids the race where the
// session record appears before the (separately written) main blob is visible.
export async function waitForCache(
  page: Page,
  opts: { mainContains?: string; decisions?: boolean; compare?: boolean },
) {
  await page.waitForFunction(
    (opts) =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open("gedmerge-session");
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
      }),
    opts,
    { timeout: 15000 },
  );
  // Chromium defers flushing IndexedDB to disk briefly; a reload within ~1s of
  // the write can lose it (a real user never reloads that fast, and the
  // unsaved-changes prompt guards them). Give the flush a margin before reload.
  await page.waitForTimeout(1500);
}

// Workspace caching is opt-in (off by default). Seed the settings blob before
// the app boots so it starts enabled — this also runs on reload. Seeding avoids
// the persistent-storage prompt path (only the in-app toggle requests it).
export async function enablePersist(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ persistWorkspace: true }));
  });
}
