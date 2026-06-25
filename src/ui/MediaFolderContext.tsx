import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "./ConfirmDialog";

const DB_NAME = "gedmerge";
const STORE_NAME = "mediaFolder";
const IDB_KEY = "handle";

// queryPermission / requestPermission are Chrome-only.
interface FsHandlePerms extends FileSystemHandle {
  queryPermission?(opts: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" }): Promise<PermissionState>;
}

function hasPermApi(h: FileSystemHandle): h is FsHandlePerms & Required<FsHandlePerms> {
  return typeof (h as FsHandlePerms).queryPermission === "function";
}

// ── Two storage modes ──────────────────────────────────────────────────────
//
// "handle"  – FileSystemDirectoryHandle from showDirectoryPicker() (Chrome/Edge).
//             Persisted in IndexedDB; permission survives page reloads.
// "filemap" – Map<string, File> built from <input webkitdirectory> (Firefox).
//             Lives only for the current session; re-pick after reload.

type FolderState =
  | { kind: "handle"; handle: FileSystemDirectoryHandle; name: string }
  | { kind: "filemap"; map: Map<string, File>; name: string }
  | null;

interface MediaFolderCtx {
  folderName: string | null;
  openFolder(): Promise<void>;
  clearFolder(): void;
  resolveFile(filePath: string): Promise<string | null>;
}

export const MediaFolderContext = createContext<MediaFolderCtx>({
  folderName: null,
  openFolder: async () => {},
  clearFolder: () => {},
  resolveFile: async () => null,
});

// ── IndexedDB helpers (Chrome/Edge only) ──────────────────────────────────

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(db: IDBDatabase): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(IDB_KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(db: IDBDatabase, value: FileSystemDirectoryHandle | null): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    if (value) {
      tx.objectStore(STORE_NAME).put(value, IDB_KEY);
    } else {
      tx.objectStore(STORE_NAME).delete(IDB_KEY);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ── File resolution helpers ────────────────────────────────────────────────

function normalizeSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

async function tryPath(
  dir: FileSystemDirectoryHandle,
  segments: string[],
): Promise<File | null> {
  try {
    let current: FileSystemDirectoryHandle = dir;
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i], { create: false });
    }
    const fh = await current.getFileHandle(segments[segments.length - 1], { create: false });
    return await fh.getFile();
  } catch {
    return null;
  }
}

async function findByBasename(
  dir: FileSystemDirectoryHandle,
  name: string,
  depth: number,
): Promise<File | null> {
  if (depth < 0) return null;
  for await (const [entryName, entry] of dir) {
    if (entry.kind === "file" && entryName.toLowerCase() === name.toLowerCase()) {
      return await (entry as FileSystemFileHandle).getFile();
    }
    if (entry.kind === "directory" && depth > 0) {
      const found = await findByBasename(entry as FileSystemDirectoryHandle, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Build lookup maps from a webkitdirectory FileList.
 *  webkitRelativePath looks like "FolderName/sub/photo.jpg".
 *  We store two keys per file:
 *    1. The path with the leading folder segment stripped ("sub/photo.jpg")
 *    2. The bare basename ("photo.jpg")
 *  Both lowercased for case-insensitive matching. */
function buildFileMap(files: FileList): { map: Map<string, File>; name: string } {
  const map = new Map<string, File>();
  let name = "";
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
    const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
    if (!name && parts.length > 0) name = parts[0];
    // Strip leading folder name for the relative key
    const withoutRoot = parts.slice(1).join("/");
    if (withoutRoot) map.set(withoutRoot.toLowerCase(), file);
    const basename = parts[parts.length - 1].toLowerCase();
    if (basename && !map.has(basename)) map.set(basename, file);
  }
  return { map, name };
}

function lookupInMap(map: Map<string, File>, filePath: string): File | null {
  const segments = normalizeSegments(filePath);
  if (segments.length === 0) return null;
  // Try progressively shorter path suffixes to handle absolute GEDCOM paths
  for (let i = 0; i < segments.length; i++) {
    const key = segments.slice(i).join("/").toLowerCase();
    const hit = map.get(key);
    if (hit) return hit;
  }
  return null;
}

// ── Provider ───────────────────────────────────────────────────────────────

export function MediaFolderProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [folder, setFolder] = useState<FolderState>(null);
  const dbRef = useRef<IDBDatabase | null>(null);
  // Resolved object URLs, plus negative entries (null) for paths known to be
  // absent in the current folder — without the latter, every unresolvable file
  // re-runs the full path probe + recursive basename scan on each lookup.
  const blobCache = useRef(new Map<string, string | null>());
  // Hidden <input webkitdirectory> for Firefox fallback
  const inputRef = useRef<HTMLInputElement | null>(null);
  // App-styled confirm/alert dialog (replaces native window.confirm/alert).
  // `cancelLabel: null` renders an acknowledge-only alert.
  const [dialog, setDialog] = useState<
    { message: string; confirmLabel: string; cancelLabel: string | null; resolve: (ok: boolean) => void } | null
  >(null);
  const askDialog = useCallback(
    (message: string, confirmLabel: string, cancelLabel: string | null) =>
      new Promise<boolean>((resolve) => setDialog({ message, confirmLabel, cancelLabel, resolve })),
    []
  );

  function revokeAll() {
    for (const url of blobCache.current.values()) if (url) URL.revokeObjectURL(url);
    blobCache.current = new Map();
  }

  // Restore persisted handle on mount (Chrome/Edge; Firefox IDB rejects handles)
  useEffect(() => {
    openIdb()
      .then(async (db) => {
        dbRef.current = db;
        const stored = await idbGet(db);
        if (!stored) return;
        if (hasPermApi(stored)) {
          const perm = await stored.queryPermission({ mode: "read" });
          if (perm === "granted" || perm === "prompt") {
            setFolder({ kind: "handle", handle: stored, name: stored.name });
          }
        } else {
          setFolder({ kind: "handle", handle: stored, name: stored.name });
        }
      })
      .catch(() => {});
  }, []);

  const openFolder = useCallback(async () => {
    if ("showDirectoryPicker" in window) {
      // Chrome / Edge path
      try {
        const dir = await (
          window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }
        ).showDirectoryPicker();
        revokeAll();
        const next: FolderState = { kind: "handle", handle: dir, name: dir.name };
        setFolder(next);
        if (dbRef.current) await idbPut(dbRef.current, dir);
      } catch {
        // user cancelled
      }
    } else if (inputRef.current) {
      // Firefox / Safari fallback — <input webkitdirectory>.
      // Only Firefox shows the misleading "upload" dialog, so warn there first.
      // Safari's picker is unambiguous, so skip the warning.
      const isFirefox = /firefox/i.test(navigator.userAgent);
      if (isFirefox) {
        const ok = await askDialog(
          t("loader.mediaFolder.firefoxWarning"),
          t("confirm.ok"),
          t("confirm.cancel"),
        );
        if (!ok) return;
      }
      inputRef.current.click();
    } else {
      await askDialog(t("loader.mediaFolder.unsupported"), t("confirm.ok"), null);
    }
  }, [askDialog, t]);

  const clearFolder = useCallback(() => {
    revokeAll();
    setFolder(null);
    if (dbRef.current) idbPut(dbRef.current, null);
  }, []);

  const resolveFile = useCallback(
    async (filePath: string): Promise<string | null> => {
      if (!folder || !filePath) return null;

      const cached = blobCache.current.get(filePath);
      if (cached !== undefined) return cached; // hit, including a known-miss (null)

      let file: File | null = null;

      if (folder.kind === "handle") {
        const { handle } = folder;
        if (hasPermApi(handle)) {
          const perm = await handle.queryPermission({ mode: "read" });
          // Permission failures are transient (the user may grant later), so
          // they're returned uncached — unlike a genuine "file not in folder".
          if (perm === "denied") return null;
          if (perm === "prompt") {
            const granted = await handle.requestPermission({ mode: "read" });
            if (granted !== "granted") return null;
          }
        }
        const segments = normalizeSegments(filePath);
        if (segments.length === 0) return null;
        const basename = segments[segments.length - 1];
        file = await tryPath(handle, segments);
        if (!file) file = await tryPath(handle, [basename]);
        if (!file) file = await findByBasename(handle, basename, 2);
      } else {
        file = lookupInMap(folder.map, filePath);
      }

      if (!file) {
        blobCache.current.set(filePath, null); // remember the miss
        return null;
      }
      const url = URL.createObjectURL(file);
      blobCache.current.set(filePath, url);
      return url;
    },
    [folder],
  );

  return (
    <MediaFolderContext.Provider
      value={{ folderName: folder?.name ?? null, openFolder, clearFolder, resolveFile }}
    >
      {/* Hidden input for Firefox webkitdirectory fallback */}
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        // webkitdirectory is not in React's HTML types; set via ref attribute
        {...{ webkitdirectory: "" }}
        multiple
        onChange={(e) => {
          const files = e.target.files;
          if (!files || files.length === 0) return;
          revokeAll();
          const { map, name } = buildFileMap(files);
          setFolder({ kind: "filemap", map, name });
          e.target.value = "";
        }}
      />
      {children}
      {dialog && (
        <ConfirmDialog
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          cancelLabel={dialog.cancelLabel}
          onConfirm={() => { dialog.resolve(true); setDialog(null); }}
          onCancel={() => { dialog.resolve(false); setDialog(null); }}
        />
      )}
    </MediaFolderContext.Provider>
  );
}

export function useMediaFolder() {
  return useContext(MediaFolderContext);
}
