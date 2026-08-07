import type { RegisterCountry } from "../../geo/addressRegister";
import { invalidateAddressRegisters } from "../../geo/addressLookup";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";

// The address-register download, owned by the module rather than by whatever
// happens to be on screen.
//
// This exists because of a bug worth remembering: the download used to belong to
// the gazetteer manager's own worker ref, which its unmount cleanup terminates.
// The manager lives in Settings › Map, behind `{tab === "map" && …}` — so
// switching tabs or closing the dialog killed a running import. For Croatia's
// one-shot file that was a narrow window; for Slovenia, whose 116 pages take
// five minutes or more, closing the dialog and going to do something else is the
// *expected* behaviour, and it ended as a spinner that simply stopped, with
// nothing downloaded and nothing said.
//
// A register import needs no UI: it fetches, parses and writes to IndexedDB by
// itself, and the only thing the screen contributes is a progress bar. So it
// runs here, for as long as it takes, and any manager that mounts meanwhile
// picks up where it has got to.

/** What the import is doing. The stages are the manager's own; `storing` is
 *  separate because writing thousands of villages into IndexedDB takes long
 *  enough that a full progress bar would read as hung. */
export type AddressDownloadState =
  | { phase: "idle" }
  | {
      phase: "running";
      country: RegisterCountry;
      stage: "waiting" | "downloading" | "parsing" | "storing";
      done: number;
      total: number;
    }
  | { phase: "error"; country: RegisterCountry; message: string }
  | { phase: "done"; country: RegisterCountry; count: number };

// Carried across Vite's hot updates in development. An import takes minutes,
// and every save reloads this module — which without this would drop the worker
// on the floor, reset the bar to idle and leave the download running invisibly
// until the tab closed. In a production build `import.meta.hot` is undefined and
// this is a plain module-level pair.
const kept = (import.meta.hot?.data ?? {}) as { state?: AddressDownloadState; worker?: Worker | null };

let state: AddressDownloadState = kept.state ?? { phase: "idle" };
let worker: Worker | null = kept.worker ?? null;
const watchers = new Set<() => void>();

import.meta.hot?.dispose((data: { state?: AddressDownloadState; worker?: Worker | null }) => {
  data.state = state;
  data.worker = worker;
});

/** The current state. A stable reference between changes, so it can back a
 *  `useSyncExternalStore`. */
export function addressDownloadState(): AddressDownloadState {
  return state;
}

export function watchAddressDownload(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function set(next: AddressDownloadState): void {
  state = next;
  for (const fn of watchers) fn();
}

/** Whether an import is on, so a second click cannot start another over it. */
export function addressDownloadRunning(): boolean {
  return state.phase === "running";
}

/** Bind a worker's messages to this module's state. Its own function because a
 *  hot update carries the worker across but not the closures the old copy of
 *  this module bound to it — rebinding is what keeps a surviving import driving
 *  the bar instead of running on invisibly. */
function attach(w: Worker, country: RegisterCountry): void {
  const finish = (next: AddressDownloadState) => {
    w.terminate();
    if (worker === w) worker = null;
    // Whatever happened, what is stored may have changed — a failed import
    // clears the old register before it writes, so the caches must be dropped
    // either way.
    invalidateAddressRegisters();
    set(next);
  };
  w.onmessage = (e: MessageEvent<GeoWorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      set({
        phase: "running",
        country,
        stage: msg.stage === "storing" ? "storing" : msg.stage === "parsing" ? "parsing" : "downloading",
        done: msg.done,
        total: msg.total,
      });
    } else if (msg.type === "addressRegister") {
      finish({ phase: "done", country, count: msg.count });
    } else if (msg.type === "error") {
      finish({ phase: "error", country, message: msg.message });
    }
  };
  // A worker that fails to load, or throws outside its own handler, would
  // otherwise leave the bar running for ever.
  w.onerror = (e) => finish({ phase: "error", country, message: e.message || "worker failed" });
  w.onmessageerror = () => finish({ phase: "error", country, message: "worker failed" });
}

// An import carried across a hot update is still running: take over its
// messages, or the bar it is driving belongs to a module nothing renders.
if (worker && state.phase === "running") attach(worker, state.country);

/**
 * Fetch and store one country's address register.
 *
 * Everything happens in the worker — the fetching too, since for Slovenia it is
 * 116 requests and for Croatia an 85 MB file, and neither belongs on the main
 * thread. Returns nothing: watch the state.
 */
export function startAddressDownload(country: RegisterCountry): void {
  if (state.phase === "running") return;
  cancelAddressDownload();
  set({ phase: "running", country, stage: "waiting", done: 0, total: 0 });

  const w = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
  worker = w;
  attach(w, country);
  const req: GeoWorkerRequest = { type: "downloadAddresses", requestId: 1, country };
  w.postMessage(req);
}

/** Stop an import, and clear whatever it last said. */
export function cancelAddressDownload(): void {
  worker?.terminate();
  worker = null;
  if (state.phase !== "idle") set({ phase: "idle" });
}

/** Acknowledge a finished or failed import — the manager calls this once it has
 *  shown the outcome, so the next mount does not report it again. */
export function clearAddressDownload(): void {
  if (state.phase === "done" || state.phase === "error") set({ phase: "idle" });
}
