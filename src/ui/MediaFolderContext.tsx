import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "./ConfirmDialog";
import { mediaKindOf, pathSegments } from "./mediaPath";
import { mediaWarnSuppressed, suppressMediaWarn } from "./mediaPrefs";

const DB_NAME = "gedmerge";
const STORE_NAME = "mediaFolder";
const IDB_KEY = "handle";

// queryPermission / requestPermission are Chrome-only.
interface FsHandlePerms extends FileSystemHandle {
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
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
  | { kind: "filemap"; map: Map<string, File>; name: string; paths: string[] }
  | null;

interface MediaFolderCtx {
  folderName: string | null;
  openFolder(): Promise<void>;
  clearFolder(): void;
  resolveFile(filePath: string): Promise<string | null>;
  /** Whether files outside the chosen folder can be dragged in (handle mode —
   *  Chrome/Edge). False in the Firefox/Safari filemap fallback, which can
   *  still reference files already inside the folder (see `listMediaFiles`). */
  canReferenceFiles: boolean;
  /** Folder-relative paths of every image file in the chosen folder, for the
   *  Add-media picker. Works in both handle and filemap modes. */
  listMediaFiles(): Promise<string[]>;
  /** Resolve a dragged file-system handle to a folder-relative path, or null
   *  when it isn't a file inside the chosen folder. */
  resolveDroppedHandle(handle: FileSystemHandle): Promise<string | null>;
  /** Whether files from outside the folder can be copied in (handle mode —
   *  Chrome/Edge; the write upgrade itself is still user-approved per session). */
  canImportFiles: boolean;
  /** Copy a file from outside into the folder root (upgrading the handle to
   *  readwrite — the browser prompts once per session) and return its
   *  folder-relative path, or null when the copy isn't possible/denied.
   *  A name collision gets a `-1`, `-2`, … suffix before the extension. */
  importFile(file: File): Promise<string | null>;
}

export const MediaFolderContext = createContext<MediaFolderCtx>({
  folderName: null,
  openFolder: async () => {},
  clearFolder: () => {},
  resolveFile: async () => null,
  canReferenceFiles: false,
  listMediaFiles: async () => [],
  resolveDroppedHandle: async () => null,
  canImportFiles: false,
  importFile: async () => null,
});

/** Whether the picker lists / a drop accepts this file (images + PDFs). */
const isMediaFile = (name: string) => mediaKindOf(name) !== null;

// `resolve` (relative path of a handle within a directory) is not yet in the
// DOM lib typings. Narrow cast kept local.
interface DirHandleResolve {
  resolve(child: FileSystemHandle): Promise<string[] | null>;
}

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
function buildFileMap(files: FileList): { map: Map<string, File>; name: string; paths: string[] } {
  const map = new Map<string, File>();
  const paths: string[] = [];
  let name = "";
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
    const parts = pathSegments(rel);
    if (!name && parts.length > 0) name = parts[0];
    // Strip leading folder name for the relative key
    const withoutRoot = parts.slice(1).join("/");
    if (withoutRoot) map.set(withoutRoot.toLowerCase(), file);
    const basename = parts[parts.length - 1].toLowerCase();
    if (basename && !map.has(basename)) map.set(basename, file);
    // Folder-relative path for the picker (basename when the file sits in root).
    paths.push(withoutRoot || parts[parts.length - 1]);
  }
  return { map, name, paths };
}

function lookupInMap(map: Map<string, File>, filePath: string): File | null {
  const segments = pathSegments(filePath);
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
  // `cancelLabel: null` renders an acknowledge-only alert; `silenceable` adds
  // the "Don't warn me again" tick that suppresses the browser-upload notice.
  const [dialog, setDialog] = useState<
    { message: string; confirmLabel: string; cancelLabel: string | null; silenceable?: boolean; resolve: (ok: boolean) => void } | null
  >(null);
  const [silenced, setSilenced] = useState(false);
  const askDialog = useCallback(
    (message: string, confirmLabel: string, cancelLabel: string | null, silenceable?: boolean) =>
      new Promise<boolean>((resolve) => setDialog({ message, confirmLabel, cancelLabel, silenceable, resolve })),
    []
  );
  // Like askDialog, but runs `onConfirm` synchronously the moment OK is clicked,
  // so it executes inside the user gesture. showDirectoryPicker() requires
  // transient activation and rejects with a SecurityError when called from a
  // later promise continuation (notably in Brave); invoking it here keeps the
  // gesture alive. Resolves to the action's result, or null if the user cancels.
  const askDialogThen = useCallback(
    <T,>(
      message: string,
      confirmLabel: string,
      cancelLabel: string | null,
      onConfirm: () => Promise<T>,
      silenceable?: boolean,
    ) =>
      new Promise<T | null>((resolve, reject) =>
        setDialog({
          message,
          confirmLabel,
          cancelLabel,
          silenceable,
          resolve: (ok) => (ok ? onConfirm().then(resolve, reject) : resolve(null)),
        }),
      ),
    [],
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
    // Brave shows the same misleading "upload" warning as Firefox before the
    // folder picker — on both the showDirectoryPicker and the webkitdirectory
    // fallback path — so reassure there first. Chrome/Edge's native "View files"
    // dialog is unambiguous, so they skip it. Detect Brave once up front, since
    // we don't know yet which path Brave will take (its File System Access
    // support has historically been gated, dropping it to the fallback).
    // Once the user has ticked "Don't warn me again", neither path warns.
    const brave = (
      navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }
    ).brave;
    const isBrave = brave?.isBrave ? await brave.isBrave() : false;
    const warn = !mediaWarnSuppressed();

    if ("showDirectoryPicker" in window) {
      const pick = () =>
        (
          window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }
        ).showDirectoryPicker();
      try {
        // On Brave the picker must fire from inside the warning's OK click to
        // keep the user gesture alive; elsewhere call it directly.
        const dir = isBrave && warn
          ? await askDialogThen(
              t("loader.mediaFolder.firefoxWarning"),
              t("confirm.ok"),
              t("confirm.cancel"),
              pick,
              true,
            )
          : await pick();
        if (!dir) return; // warning dialog cancelled
        revokeAll();
        const next: FolderState = { kind: "handle", handle: dir, name: dir.name };
        setFolder(next);
        if (dbRef.current) await idbPut(dbRef.current, dir);
      } catch {
        // user cancelled the native picker
      }
    } else if (inputRef.current) {
      // Firefox / Safari / gated-Brave fallback — <input webkitdirectory>.
      // Firefox and Brave show the misleading "upload" dialog, so warn first.
      // Safari's picker is unambiguous, so skip the warning.
      const isFirefox = /firefox/i.test(navigator.userAgent);
      if ((isFirefox || isBrave) && warn) {
        const ok = await askDialog(
          t("loader.mediaFolder.firefoxWarning"),
          t("confirm.ok"),
          t("confirm.cancel"),
          true,
        );
        if (!ok) return;
      }
      inputRef.current.click();
    } else {
      await askDialog(t("loader.mediaFolder.unsupported"), t("confirm.ok"), null);
    }
  }, [askDialog, askDialogThen, t]);

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
            // requestPermission only shows its dialog under transient user
            // activation. Thumbnail loads run from effects (no activation), so
            // requesting there is a silent no-op that just leaves perm at
            // "prompt"; skip it and let the click that opens the viewer — a real
            // gesture — do the asking. Avoids a confusing first-load state where
            // the prompt never appears.
            if (!navigator.userActivation?.isActive) return null;
            const granted = await handle.requestPermission({ mode: "read" });
            if (granted !== "granted") return null;
          }
        }
        const segments = pathSegments(filePath);
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

  const listMediaFiles = useCallback(async (): Promise<string[]> => {
    if (!folder) return [];
    if (folder.kind === "filemap") return folder.paths.filter(isMediaFile);
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, entry] of dir) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === "file") {
          if (isMediaFile(name)) out.push(path);
        } else if (entry.kind === "directory") {
          await walk(entry as FileSystemDirectoryHandle, path);
        }
      }
    };
    try {
      await walk(folder.handle, "");
    } catch {
      // permission revoked / read error — return whatever we gathered
    }
    return out;
  }, [folder]);

  const resolveDroppedHandle = useCallback(
    async (handle: FileSystemHandle): Promise<string | null> => {
      if (!folder || folder.kind !== "handle" || handle.kind !== "file") return null;
      const segments = await (folder.handle as unknown as DirHandleResolve).resolve(handle);
      return segments ? segments.join("/") : null;
    },
    [folder],
  );

  const importFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (!folder || folder.kind !== "handle") return null;
      const dir = folder.handle;
      // Upgrade to readwrite; the browser prompts once per session. Without the
      // permission API (non-Chromium), the create call below just fails → null.
      if (hasPermApi(dir)) {
        let perm = await dir.queryPermission({ mode: "readwrite" });
        if (perm === "prompt") perm = await dir.requestPermission({ mode: "readwrite" });
        if (perm !== "granted") return null;
      }
      // Pick a free name: "photo.jpg" → "photo-1.jpg", "photo-2.jpg", …
      const dot = file.name.lastIndexOf(".");
      const base = dot > 0 ? file.name.slice(0, dot) : file.name;
      const ext = dot > 0 ? file.name.slice(dot) : "";
      let name = file.name;
      for (let n = 1; ; n++) {
        try {
          await dir.getFileHandle(name, { create: false });
          name = `${base}-${n}${ext}`; // taken — try the next suffix
        } catch {
          break; // free
        }
      }
      try {
        const fh = await dir.getFileHandle(name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(file);
        await writable.close();
      } catch {
        return null; // write failed (permission revoked mid-flight, disk error)
      }
      // A stale known-miss for this name would hide the fresh copy.
      blobCache.current.delete(name);
      return name;
    },
    [folder],
  );

  return (
    <MediaFolderContext.Provider
      value={{
        folderName: folder?.name ?? null,
        openFolder,
        clearFolder,
        resolveFile,
        canReferenceFiles: folder?.kind === "handle",
        listMediaFiles,
        resolveDroppedHandle,
        canImportFiles: folder?.kind === "handle",
        importFile,
      }}
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
          const { map, name, paths } = buildFileMap(files);
          setFolder({ kind: "filemap", map, name, paths });
          e.target.value = "";
        }}
      />
      {children}
      {dialog && (
        <ConfirmDialog
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          cancelLabel={dialog.cancelLabel}
          checkboxLabel={dialog.silenceable ? t("loader.mediaFolder.noWarn") : undefined}
          checked={silenced}
          onCheckedChange={setSilenced}
          // Persist before resolving: on the Brave path `resolve` opens the
          // folder picker synchronously to keep the user gesture alive.
          onConfirm={() => {
            if (dialog.silenceable && silenced) suppressMediaWarn();
            dialog.resolve(true);
            setDialog(null);
            setSilenced(false);
          }}
          onCancel={() => { dialog.resolve(false); setDialog(null); setSilenced(false); }}
        />
      )}
    </MediaFolderContext.Provider>
  );
}

export function useMediaFolder() {
  return useContext(MediaFolderContext);
}
