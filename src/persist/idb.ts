// IndexedDB-backed workspace persistence.
//
// Caches the loaded main/compare GEDCOM files and the pending *merge* session
// (decisions, import-branch selections, home person) so a reload restores the
// workspace instead of dropping back to the landing page. Mirrors the
// handle-persistence pattern in MediaFolderContext: its own DB, best-effort,
// and every operation swallows errors (a storage failure must never break the
// app — it just means nothing was cached).
//
// Stored data needs NO browser permission — it is same-origin IndexedDB. The
// only data at rest here is GEDCOM text the user already loaded locally.
//
// Scope note: in-progress *edit-mode* mutations and the undo/redo stack are
// deliberately NOT persisted. Edits are applied in place and restoring them
// correctly would require replaying patches through EditView; the existing
// beforeunload warning already guards accidental edit loss. The merge session
// restores cleanly because decisions are keyed by stable GEDCOM xrefs and are
// not baked into the dataset until save, so a re-parse reproduces identical keys.

import type { CandidateDecision } from "../review/types";
import type { GedNode } from "../gedcom/types";
import type { UndoEntry } from "../edit-state/useUndoRedo";
import type { SharedRecordSnapshot } from "../edit-state/useDirtyTracking";

const DB_NAME = "gedmerge-session";
const DB_VERSION = 1;
const FILES_STORE = "files"; // keyed "main" | "compare"
const SESSION_STORE = "session"; // keyed "current"

/**
 * Version of the *shapes* persisted in the session store (`DB_VERSION` only
 * covers the store layout). `StoredSession` embeds `CandidateDecision`,
 * `UndoEntry` and dirty-tracking snapshots whose types evolve with the app;
 * hydrating a stale shape after a deploy could throw during startup. Bump
 * this whenever any of those persisted types changes incompatibly — an older
 * session is then discarded on load instead of hydrated (the cached files
 * themselves are plain blobs and always survive). Sessions written before
 * this field existed carry the version-1 shapes, so absence reads as 1.
 *
 * Schema 2: the "master" vocabulary became "main" — the files-store key and
 * the persisted `mainFileName` / field-choice values all renamed.
 */
const SESSION_SCHEMA = 2;

/** Files-store key used before the master→main rename; read as a fallback so
 *  cached files written by older app versions still restore. */
const LEGACY_MAIN_KEY = "master";

type FileRole = "main" | "compare";
const SESSION_KEY = "current";

/** A cached loaded file, kept as a Blob so the exact bytes (and charset) round-trip. */
export interface StoredFile {
  fileName: string;
  blob: Blob;
  /** Compare slot only: the file was a genealogical-index matches CSV. */
  isCsv?: boolean;
  savedAt: number;
  /** SHA-256 of the file's bytes *as originally loaded from disk* — fixed at
   *  first load and carried through unchanged by later cache writes (which may
   *  re-serialize an edited dataset into `blob`). Lets a restore detect that
   *  the on-disk file itself has since changed, as opposed to in-app edits. */
  originalHash?: string;
  /** Chrome/Edge only: a live handle to the source file, so a restore can
   *  silently re-read it and compare against `originalHash`. Structured-clone
   *  friendly, same technique as the media-folder directory handle. */
  handle?: FileSystemFileHandle;
}

/** Unsaved Edit-mode state, present only once the dataset has actually been
 *  edited. The cached main file then holds the *edited* serialization, so the
 *  re-parsed dataset is post-edit; diffing it against these pre-edit snapshots
 *  reproduces the change report and pending counts. `GedNode`/`UndoEntry` trees
 *  are structured-cloneable, so they round-trip through IndexedDB as-is. */
export interface StoredEditState {
  loadedPersonIds: string[];
  loadedFamilyIds: string[];
  changedPersonIds: string[];
  changedFamilyIds: string[];
  /** Standalone shared-record (SOUR/OBJE) edits; absent in pre-existing caches. */
  changedRecordIds?: string[];
  personSnapshots: [string, GedNode][];
  familySnapshots: [string, GedNode][];
  /** Shared-record (SOUR/OBJE) snapshots; absent in pre-existing caches. */
  recordSnapshots?: [string, SharedRecordSnapshot][];
  sortEligiblePersonIds: string[];
  /** The unified undo/redo history (edit + merge + import entries). */
  undo: UndoEntry[];
  redo: UndoEntry[];
}

/** The pending merge session, co-persisted with the main it belongs to. */
export interface StoredSession {
  /** {@link SESSION_SCHEMA} at write time; stamped by `saveSession`. */
  schema?: number;
  mainFileName: string;
  compareFileName?: string;
  /** `Array.from(decisions)` — Maps don't survive JSON but the entry array does. */
  decisions: [string, CandidateDecision][];
  importBranches: string[];
  /** Rejected within-file duplicate pairs (Tools tab), keyed by
   *  `duplicatePairKey(...)`. Restored only if `mainFileName` still matches the
   *  freshly-parsed main — see the restore site in App.tsx. */
  rejectedDuplicates?: string[];
  startId?: string;
  /** Present only when the dataset has unsaved edits; see {@link StoredEditState}. */
  editState?: StoredEditState;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      // Don't cache a transient open failure (a briefly locked profile at
      // boot) as "no persistence forever" — the next operation retries.
      dbPromise = undefined;
      resolve(null);
    };
  });
  return dbPromise;
}

/** Run `fn` against the shared connection; never throws (returns `fallback`). */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  return fn(db);
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Read the whole cached workspace in one shot for startup hydration. */
export function loadWorkspace(): Promise<{
  main?: StoredFile;
  compare?: StoredFile;
  session?: StoredSession;
}> {
  return withDb<{ main?: StoredFile; compare?: StoredFile; session?: StoredSession }>(async (db) => {
    const [mainNew, mainLegacy, compare, session] = await Promise.all([
      idbGet<StoredFile>(db, FILES_STORE, "main"),
      idbGet<StoredFile>(db, FILES_STORE, LEGACY_MAIN_KEY),
      idbGet<StoredFile>(db, FILES_STORE, "compare"),
      idbGet<StoredSession>(db, SESSION_STORE, SESSION_KEY),
    ]);
    const main = mainNew ?? mainLegacy;
    // A session written by an incompatible app version is discarded rather
    // than hydrated into the wrong shapes; the cached files still restore.
    const compatible = session && (session.schema ?? 1) === SESSION_SCHEMA ? session : undefined;
    return { main, compare, session: compatible };
  }, {});
}

export function saveFile(role: FileRole, file: StoredFile): Promise<void> {
  return withDb((db) => idbPut(db, FILES_STORE, role, file), undefined);
}

export function deleteFile(role: FileRole): Promise<void> {
  return withDb(async (db) => {
    await idbDelete(db, FILES_STORE, role);
    if (role === "main") await idbDelete(db, FILES_STORE, LEGACY_MAIN_KEY);
  }, undefined);
}

export function saveSession(session: StoredSession): Promise<void> {
  return withDb(
    (db) => idbPut(db, SESSION_STORE, SESSION_KEY, { ...session, schema: SESSION_SCHEMA }),
    undefined,
  );
}

/**
 * Write the (possibly edited) main blob and the session in ONE transaction, so
 * a failure — or a tab closing — between the two can never persist an edited
 * main beside a stale edit-state: hydration would then diff pre-edit snapshots
 * against a dataset they don't describe. `file` is optional for the common
 * tick where only the session changed. Unlike the other operations this
 * reports failure (false: quota, eviction, no IndexedDB at all), so the
 * debounced writer can tell the user that restore-on-reload is broken instead
 * of failing silently forever.
 */
export function saveMainAndSession(file: StoredFile | undefined, session: StoredSession): Promise<boolean> {
  return withDb<boolean>(
    (db) =>
      new Promise((resolve) => {
        try {
          const tx = db.transaction(file ? [FILES_STORE, SESSION_STORE] : [SESSION_STORE], "readwrite");
          if (file) tx.objectStore(FILES_STORE).put(file, "main");
          tx.objectStore(SESSION_STORE).put({ ...session, schema: SESSION_SCHEMA }, SESSION_KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
    false,
  );
}

/** Wipe every cached file and the session — the Settings "clear cached data" path. */
export function clearWorkspace(): Promise<void> {
  return withDb(async (db) => {
    await Promise.all([
      idbDelete(db, FILES_STORE, "main"),
      idbDelete(db, FILES_STORE, LEGACY_MAIN_KEY),
      idbDelete(db, FILES_STORE, "compare"),
      idbDelete(db, SESSION_STORE, SESSION_KEY),
    ]);
  }, undefined);
}

// ── Fresh-start flag ────────────────────────────────────────────────────────
//
// The logo click reloads to the landing page instead of restoring the cached
// workspace. The intent is recorded in localStorage rather than by deleting
// from IndexedDB before the reload: the write is synchronous, so the reload
// stays inside the user's click activation (Firefox blocks a programmatic
// reload fired from an async continuation) and the mark can't be lost to an
// IndexedDB transaction racing page teardown.

const FRESH_START_KEY = "gedmerge.fresh-start";

/** Mark the next app boot to discard the cached workspace instead of restoring it. */
export function markFreshStart(): void {
  try {
    localStorage.setItem(FRESH_START_KEY, "1");
  } catch {
    /* best-effort */
  }
}

/** Consume the fresh-start mark: true when this boot should skip the restore. */
export function consumeFreshStart(): boolean {
  try {
    if (localStorage.getItem(FRESH_START_KEY) === null) return false;
    localStorage.removeItem(FRESH_START_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Ask the browser to make storage durable (survive eviction under pressure).
 *  Granted silently or via a one-time prompt depending on engagement; failure
 *  is harmless (storage stays best-effort). Call once after the first save. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best-effort */
  }
}
