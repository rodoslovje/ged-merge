import { useEffect, useRef, useState, type Dispatch, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { serializeGedcom } from "../gedcom/serialize";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import type { DatasetRole, WorkerRequest } from "../worker/messages";
import type { useDirtyTracking } from "../edit-state/useDirtyTracking";
import type { useUndoRedo } from "../edit-state/useUndoRedo";
import {
  clearWorkspace, consumeFreshStart, loadWorkspace, requestPersistentStorage,
  saveFile, saveSession, type StoredEditState, type StoredSession,
} from "./idb";
import { hashFile, hasPermApi } from "./fingerprint";
import { useSettings } from "../ui/SettingsContext";

export interface WorkspacePersistenceOptions {
  /** The opt-in workspace-caching setting (`settings.persistWorkspace`). */
  persistEnabled: boolean;
  workspace: WorkspaceState;
  /** The live (possibly edited) main dataset — what the debounced writer serializes. */
  mainDataset: Dataset | undefined;
  /** Bumps on every dataset-mutating edit; > 0 = differs from the loaded file. */
  editVersion: number;
  dirty: ReturnType<typeof useDirtyTracking>;
  undoRedo: ReturnType<typeof useUndoRedo>;
  sortEligiblePersonIdsRef: MutableRefObject<Set<string>>;
  post: (msg: WorkerRequest, transfer?: Transferable[]) => void;
  dispatch: Dispatch<WorkspaceAction>;
  /** App's one-time default-start-person guard — set when a cached session
   *  carries a start person, so the default doesn't fight the restore. */
  autoStartRef: MutableRefObject<boolean>;
  loadFile: (role: DatasetRole, file: File, handle?: FileSystemFileHandle) => Promise<void>;
  confirmDialog: (message: string, confirmLabel: string, onConfirmAction?: () => void) => Promise<boolean>;
  setSaveToast: (msg: string | null) => void;
}

/**
 * Opt-in IndexedDB workspace persistence: the startup hydration (re-feeding
 * cached files through the worker), the debounced session/main writer, the
 * enable/disable toggle reaction, and the on-disk external-change checks
 * (silent at startup, gesture-backed via `verifyNow`).
 *
 * Owns every piece of state those flows share — the restore-in-progress refs
 * the worker-message handlers coordinate on, the cached blobs/hashes/handles,
 * and the `mainCachedRef` "sole main writer" flag — and returns them for the
 * load/save/unload flows that remain in App.
 */
export function useWorkspacePersistence(opts: WorkspacePersistenceOptions) {
  const { t } = useTranslation();
  const { persistEnabled } = opts;
  // Mirrored into a ref so the mount-only hydration effect reads the current
  // value without needing to re-run, and (non-memoized) closures in App always
  // see it fresh.
  const persistEnabledRef = useRef(persistEnabled);
  persistEnabledRef.current = persistEnabled;
  // Current format overrides for the restore-time parse posts (mount-only
  // effect — read through a ref so it sees the loaded settings).
  const { settings } = useSettings();
  const formatOverridesRef = useRef(settings.formatOverrides);
  formatOverridesRef.current = settings.formatOverrides;

  // A merge session read from IndexedDB on startup, applied once the first match
  // result arrives (the candidate list it keys into must exist first). Null when
  // there is nothing to restore or it has already been consumed.
  const pendingSessionRef = useRef<StoredSession | null>(null);
  // Gates session persistence: stays false until the startup restore has settled
  // (or there was nothing to restore), so the debounced writer can't overwrite a
  // cached session with the empty state that exists mid-restore.
  const hydratedRef = useRef(false);
  // Whether the startup restore is still waiting on a compare file to match —
  // decides whether persistence is enabled after the main parses or only once
  // matching completes.
  const expectCompareRef = useRef(false);
  // Edit-state cached from a previous session, applied (instead of resetOnLoad)
  // once the edited main re-parses. Null when there is nothing to restore.
  const pendingEditStateRef = useRef<StoredEditState | null>(null);
  // Set on the first user-initiated load. The startup restore checks it before
  // (and after) each async hop: a user who drops a file while the cached
  // workspace is still being read must win — feeding the cached file to the
  // worker afterwards would overwrite the user's freshly-loaded one.
  const userLoadedRef = useRef(false);
  // The raw compare Blob (File on load, cached Blob on hydrate) — kept so that
  // enabling persistence mid-session can cache the compare exactly, including a
  // CSV that can't be re-serialized from its dataset.
  const compareBlobRef = useRef<Blob | null>(null);
  // Whether the main blob has been cached this session. The debounced effect
  // is the *sole* writer of the main key (serializing the live dataset), so a
  // fire-and-forget original write from loadFile can't race and clobber a later
  // edited write. False after a fresh main load → the next debounce caches it.
  const mainCachedRef = useRef(false);
  // Live FileSystemFileHandle for main/compare, when the browser supports the
  // File System Access API and the file was picked/dropped via one (Firefox/
  // Safari, or a plain drag of a file without a resolvable handle, leave this
  // null). State (not a ref) because it drives the "Verify" button's visibility.
  const [mainHandle, setMainHandle] = useState<FileSystemFileHandle | null>(null);
  const [compareHandle, setCompareHandle] = useState<FileSystemFileHandle | null>(null);
  // SHA-256 of the file's bytes *as loaded from disk*, fixed at load time and
  // carried unchanged through every later cache write (which may re-serialize
  // an edited main dataset) — see fingerprint.ts. Used to tell "the on-disk
  // file changed" apart from "I edited it in here".
  const mainOriginalHashRef = useRef<string | null>(null);
  const compareOriginalHashRef = useRef<string | null>(null);
  // Set (only from the startup-restore effect) when a silent disk check finds
  // the cached file no longer matches what's on disk. A separate effect below
  // reacts to it with a fresh `loadFile`/handle closure, since the effect that
  // detects the mismatch runs once at mount and can't safely call either.
  const [externalChangeAlert, setExternalChangeAlert] = useState<{ role: DatasetRole; fileName: string } | null>(null);

  // Restore a cached workspace on mount: re-feed the stored files through the
  // worker so the parse → normalize → match pipeline (and start-person ranking)
  // rebuilds exactly as a fresh load would. The merge session is stashed and
  // applied once the first match result arrives and the candidate list exists.
  const { post, dispatch, autoStartRef } = opts;
  useEffect(() => {
    let cancelled = false;
    // Logo-click fresh start: skip the restore and drop the cached workspace so
    // this (and every later) boot lands on the loader.
    if (consumeFreshStart()) {
      void clearWorkspace();
      hydratedRef.current = true;
      return;
    }
    // Only read the cache when the user has opted in; otherwise there is nothing
    // stored and we go straight to the landing page.
    const hydrate: ReturnType<typeof loadWorkspace> = persistEnabledRef.current
      ? loadWorkspace()
      : Promise.resolve({});
    void hydrate.then((ws) => {
      if (cancelled || userLoadedRef.current) return;
      if (!ws.main) {
        hydratedRef.current = true; // nothing cached — persist freely from here
        return;
      }
      pendingSessionRef.current = ws.session ?? null;
      pendingEditStateRef.current = ws.session?.editState ?? null;
      expectCompareRef.current = !!ws.compare;
      mainCachedRef.current = true; // restored main is already in the cache
      setMainHandle(ws.main.handle ?? null);
      mainOriginalHashRef.current = ws.main.originalHash ?? null;
      if (ws.compare) {
        compareBlobRef.current = ws.compare.blob;
        setCompareHandle(ws.compare.handle ?? null);
        compareOriginalHashRef.current = ws.compare.originalHash ?? null;
      }
      // A cached start person will be restored explicitly; suppress the one-time
      // auto-default so it doesn't fight the restore.
      if (ws.session?.startId) autoStartRef.current = true;
      const feed = (role: DatasetRole, sf: NonNullable<typeof ws.main>) => {
        dispatch({ type: "slotLoading", role, fileName: sf.fileName });
        void sf.blob.arrayBuffer().then((buffer) => {
          if (cancelled || userLoadedRef.current) return;
          post(
            sf.isCsv
              ? { type: "parseCsv", fileName: sf.fileName, buffer }
              : { type: "parse", role, fileName: sf.fileName, buffer, formatOverrides: formatOverridesRef.current },
            [buffer],
          );
        });
      };
      feed("main", ws.main); // main first so its profile is set before compare normalizes
      if (ws.compare) feed("compare", ws.compare);

      // Best-effort, silent check that the on-disk file still matches what we
      // cached (Chrome/Edge only, and only when the browser still reports read
      // permission without a prompt — a live gesture is needed otherwise, which
      // the "Verify" button provides). A mismatch surfaces via `externalChangeAlert`,
      // handled by a separate effect that always sees the current render's
      // `loadFile`/handle state (this mount effect's closure would otherwise call
      // a permanently-stale `loadFile`).
      const verifyOnHydrate = async (role: DatasetRole, sf: NonNullable<typeof ws.main>) => {
        if (!sf.handle || !sf.originalHash || !hasPermApi(sf.handle)) return;
        try {
          const perm = await sf.handle.queryPermission({ mode: "read" });
          if (perm !== "granted") return;
          const file = await sf.handle.getFile();
          const hash = await hashFile(file);
          if (cancelled) return;
          if (hash !== sf.originalHash) setExternalChangeAlert({ role, fileName: sf.fileName });
        } catch {
          /* handle stale/revoked, file moved, etc. — nothing to report */
        }
      };
      void verifyOnHydrate("main", ws.main);
      if (ws.compare) void verifyOnHydrate("compare", ws.compare);
    });
    return () => { cancelled = true; };
  }, [post, dispatch, autoStartRef]);

  // Reacts to a mismatch found by the startup-restore's silent disk check
  // (`externalChangeAlert`). Kept as its own effect — rather than resolving the
  // reload inline where the mismatch is found — because that check runs once in
  // the mount-only hydration effect, whose closure over `loadFile`/handle state
  // is permanently stale; this effect re-fires fresh each time the alert is set,
  // so it always sees the current render's `loadFile` and handle state.
  useEffect(() => {
    if (!externalChangeAlert) return;
    const { role, fileName } = externalChangeAlert;
    void opts.confirmDialog(t("load.externalChange", { fileName }), t("load.externalChange.reload")).then((reload) => {
      setExternalChangeAlert(null);
      if (!reload) return;
      const handle = role === "main" ? mainHandle : compareHandle;
      if (!handle) return;
      void handle.getFile().then((file) => opts.loadFile(role, file, handle));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalChangeAlert]);

  /** Manual re-check for the loaded main/compare file against disk (the
   *  "Verify" button in GedcomLoader) — unlike the silent startup check, a real
   *  click gesture lets this request permission if it isn't already granted. */
  async function verifyNow(role: DatasetRole) {
    const handle = role === "main" ? mainHandle : compareHandle;
    const originalHash = role === "main" ? mainOriginalHashRef.current : compareOriginalHashRef.current;
    if (!handle || !originalHash) return;
    if (hasPermApi(handle)) {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm === "prompt") perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") {
        opts.setSaveToast(t("load.verify.denied"));
        return;
      }
    }
    let file: File;
    try {
      file = await handle.getFile();
    } catch {
      opts.setSaveToast(t("load.verify.unreadable"));
      return;
    }
    const hash = await hashFile(file);
    if (hash === originalHash) {
      opts.setSaveToast(t("load.verify.unchanged"));
      return;
    }
    if (await opts.confirmDialog(t("load.externalChange", { fileName: file.name }), t("load.externalChange.reload"))) {
      void opts.loadFile(role, file, handle);
    }
  }

  /** Settings → wipe the cached workspace (main/compare files + merge session)
   *  from IndexedDB. Doesn't touch the live, in-memory session — the current
   *  work stays loaded; only the persisted copy used to restore on reload goes. */
  async function handleClearCache() {
    if (!(await opts.confirmDialog(t("settings.data.clearConfirm"), t("confirm.continue")))) return;
    await clearWorkspace();
    opts.setSaveToast(t("settings.data.cleared"));
  }

  // Persist the workspace so a reload restores it: the pending merge session
  // (decisions, import branches, start person) plus, once the dataset has been
  // edited, the edited main text and the edit-state (dirty tracking + undo
  // history). Debounced because these change rapidly while working; keyed to the
  // loaded main/compare so a stale restore can be skipped.
  const { main, compare, lastMainFile, decisions, importBranches, rejectedDuplicates, startId } = opts.workspace;
  const { mainDataset, editVersion, dirty, undoRedo, sortEligiblePersonIdsRef } = opts;
  useEffect(() => {
    if (!persistEnabled) return; // caching is opt-in
    const mainFileName = lastMainFile?.fileName;
    if (!mainFileName) return; // nothing loaded yet → nothing to cache
    if (!hydratedRef.current) return; // a startup restore is still settling
    // While a main (re)load is parsing, lastMainFile/mainDataset still hold the
    // PREVIOUS file. Writing then would cache the old file's text and flip
    // mainCachedRef, so the new file would never be cached this session and a
    // reload would restore the old one. `main` is in the deps, so the
    // slotLoading dispatch also cancels any already-scheduled write below.
    if (main.status !== "loaded") return;
    const handle = window.setTimeout(async () => {
      const edited = editVersion > 0; // dataset differs from the cached original
      const editState: StoredEditState | undefined = edited
        ? { ...dirty.serialize(), sortEligiblePersonIds: [...sortEligiblePersonIdsRef.current], ...undoRedo.serialize() }
        : undefined;
      // Cache the main's *current* serialization (edited or original) — this
      // effect is the sole main writer. Re-serialize when the dataset has been
      // edited, or once when it hasn't been cached yet this session (a pure-merge
      // session then serializes only that first time, not on every decision). It
      // is written before the session below, so a session record always points
      // at an already-committed main.
      if (mainDataset && (edited || !mainCachedRef.current)) {
        await saveFile("main", {
          fileName: mainFileName,
          blob: new Blob([serializeGedcom(mainDataset.records, { eol: mainDataset.eol, finalNewline: mainDataset.finalNewline })]),
          savedAt: Date.now(),
          originalHash: mainOriginalHashRef.current ?? undefined,
          handle: mainHandle ?? undefined,
        });
        mainCachedRef.current = true;
      }
      await saveSession({
        mainFileName,
        compareFileName: compare.status === "loaded" ? compare.file.fileName : undefined,
        decisions: Array.from(decisions),
        importBranches: Array.from(importBranches),
        rejectedDuplicates: Array.from(rejectedDuplicates),
        startId,
        editState,
        savedAt: Date.now(),
      });
    }, 800);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistEnabled, decisions, importBranches, rejectedDuplicates, startId, main, compare, lastMainFile, editVersion, dirty.changedPersonIds, dirty.changedFamilyIds, mainHandle]);

  // React to the opt-in toggle: on enable, request durable storage (the only
  // place that may prompt) and cache the current workspace right away; on
  // disable, wipe the cache. The debounced effect above writes the session.
  const prevPersistRef = useRef(persistEnabled);
  useEffect(() => {
    if (persistEnabled === prevPersistRef.current) return; // includes the mount no-op
    prevPersistRef.current = persistEnabled;
    if (!persistEnabled) {
      void clearWorkspace();
      return;
    }
    void requestPersistentStorage();
    const ds = lastMainFile?.dataset;
    if (ds && lastMainFile) {
      void saveFile("main", {
        fileName: lastMainFile.fileName,
        blob: new Blob([serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })]),
        savedAt: Date.now(),
        originalHash: mainOriginalHashRef.current ?? undefined,
        handle: mainHandle ?? undefined,
      });
    }
    if (compareBlobRef.current && compare.status === "loaded") {
      void saveFile("compare", {
        fileName: compare.file.fileName,
        blob: compareBlobRef.current,
        isCsv: /\.csv$/i.test(compare.file.fileName),
        savedAt: Date.now(),
        originalHash: compareOriginalHashRef.current ?? undefined,
        handle: compareHandle ?? undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistEnabled]);

  return {
    persistEnabled,
    pendingSessionRef,
    pendingEditStateRef,
    hydratedRef,
    expectCompareRef,
    userLoadedRef,
    compareBlobRef,
    mainCachedRef,
    mainOriginalHashRef,
    compareOriginalHashRef,
    mainHandle,
    setMainHandle,
    compareHandle,
    setCompareHandle,
    verifyNow,
    handleClearCache,
  };
}
