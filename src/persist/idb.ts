// IndexedDB-backed workspace persistence.
//
// Caches the loaded master/compare GEDCOM files and the pending *merge* session
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

const DB_NAME = "gedmerge-session";
const DB_VERSION = 1;
const FILES_STORE = "files"; // keyed "master" | "compare"
const SESSION_STORE = "session"; // keyed "current"

type FileRole = "master" | "compare";
const SESSION_KEY = "current";

/** A cached loaded file, kept as a Blob so the exact bytes (and charset) round-trip. */
export interface StoredFile {
  fileName: string;
  blob: Blob;
  /** Compare slot only: the file was a genealogical-index matches CSV. */
  isCsv?: boolean;
  savedAt: number;
}

/** Unsaved Edit-mode state, present only once the dataset has actually been
 *  edited. The cached master file then holds the *edited* serialization, so the
 *  re-parsed dataset is post-edit; diffing it against these pre-edit snapshots
 *  reproduces the change report and pending counts. `GedNode`/`UndoEntry` trees
 *  are structured-cloneable, so they round-trip through IndexedDB as-is. */
export interface StoredEditState {
  loadedPersonIds: string[];
  loadedFamilyIds: string[];
  changedPersonIds: string[];
  changedFamilyIds: string[];
  personSnapshots: [string, GedNode][];
  familySnapshots: [string, GedNode][];
  sortEligiblePersonIds: string[];
  /** The unified undo/redo history (edit + merge + import entries). */
  undo: UndoEntry[];
  redo: UndoEntry[];
}

/** The pending merge session, co-persisted with the master it belongs to. */
export interface StoredSession {
  masterFileName: string;
  compareFileName?: string;
  /** `Array.from(decisions)` — Maps don't survive JSON but the entry array does. */
  decisions: [string, CandidateDecision][];
  importBranches: string[];
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
    req.onerror = () => resolve(null);
  });
  return dbPromise;
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
export async function loadWorkspace(): Promise<{
  master?: StoredFile;
  compare?: StoredFile;
  session?: StoredSession;
}> {
  const db = await openDb();
  if (!db) return {};
  const [master, compare, session] = await Promise.all([
    idbGet<StoredFile>(db, FILES_STORE, "master"),
    idbGet<StoredFile>(db, FILES_STORE, "compare"),
    idbGet<StoredSession>(db, SESSION_STORE, SESSION_KEY),
  ]);
  return { master, compare, session };
}

export async function saveFile(role: FileRole, file: StoredFile): Promise<void> {
  const db = await openDb();
  if (db) await idbPut(db, FILES_STORE, role, file);
}

export async function deleteFile(role: FileRole): Promise<void> {
  const db = await openDb();
  if (db) await idbDelete(db, FILES_STORE, role);
}

export async function saveSession(session: StoredSession): Promise<void> {
  const db = await openDb();
  if (db) await idbPut(db, SESSION_STORE, SESSION_KEY, session);
}

/** Wipe every cached file and the session — the Settings "clear cached data" path. */
export async function clearWorkspace(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await Promise.all([
    idbDelete(db, FILES_STORE, "master"),
    idbDelete(db, FILES_STORE, "compare"),
    idbDelete(db, SESSION_STORE, SESSION_KEY),
  ]);
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
