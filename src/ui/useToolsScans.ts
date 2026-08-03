import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import type { DuplicatePair } from "../tools/duplicates";
import type { ValidationReport } from "../tools/validate";
import type { StructureReport } from "../tools/structure";
import type { DuplicateReport } from "../tools/sourceDuplicates";
import type { ReshapeReport } from "../tools/sourceReshape";
import type { FormatOverrides } from "../normalize/formatOverrides";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "../worker/toolsMessages";
import { useSettingsSlice } from "./SettingsContext";

/** Lifecycle of one whole-file scan. */
export type AsyncState<T> =
  | { status: "idle" }
  | { status: "running"; progress?: { done: number; total: number } }
  | { status: "cancelled" }
  | { status: "error"; message: string }
  | { status: "done"; result: T };

/** The scans that cache their result here (all but the download serializer). */
type ScanKind = "validate" | "duplicates" | "normalize" | "sourceDuplicates" | "sourceReshape";

interface ScanStates {
  validate: AsyncState<{ report: ValidationReport; structure: StructureReport }>;
  duplicates: AsyncState<DuplicatePair[]>;
  normalize: AsyncState<NormalizationReport>;
  sourceDuplicates: AsyncState<DuplicateReport>;
  sourceReshape: AsyncState<ReshapeReport>;
}

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["formatOverrides"] as const;

const ALL_IDLE: ScanStates = {
  validate: { status: "idle" },
  duplicates: { status: "idle" },
  normalize: { status: "idle" },
  sourceDuplicates: { status: "idle" },
  sourceReshape: { status: "idle" },
};

/** Worker request type for each scan kind. */
const REQUEST_TYPE = {
  validate: "validate",
  duplicates: "findDuplicates",
  normalize: "normalizePreview",
  sourceDuplicates: "sourceDuplicates",
  sourceReshape: "sourceReshape",
} as const;

/** Which format-override dimensions a scan's result depends on: a change to one
 *  of these must re-run that scan (and only that one). Scans absent here are
 *  independent of the reader's format choices. */
const SALT_KEYS: Partial<Record<ScanKind, readonly (keyof FormatOverrides)[]>> = {
  sourceReshape: ["pageMedia", "sourceLayout", "baptism", "doubledLinks"],
  normalize: ["date", "datePlaceholder", "place", "placeSeparator", "names", "unknownName", "matriculaLang", "geneanetLang"],
};

export interface ToolsScans extends ScanStates {
  /** Start a scan unless it already ran (or is running) for this file. */
  ensure: (kind: ScanKind) => void;
  /** Like `ensure`, but also re-runs when the dataset content changed since
   *  the cached result (in-place edits bump `editVersionRef`). For scans cheap
   *  enough to re-run automatically — a stale result must not drive an apply. */
  ensureFresh: (kind: ScanKind) => void;
  /** Re-run a scan against the current (possibly just-edited) dataset. */
  refresh: (kind: ScanKind) => void;
  /** True when a finished scan's result was computed against older content than
   *  the dataset now holds — the panel can offer a re-run and say why. */
  isStale: (kind: ScanKind) => boolean;
  /** Stop the running duplicate scan. Terminates the worker — the only way to
   *  interrupt its synchronous pass — so the next scan re-uploads the file. */
  cancelDuplicates: () => void;
  /** Locally rewrite the cached duplicate list (a merge folds pairs away, a
   *  related pair gets prepended) without re-running the scan. */
  updateDuplicates: (fn: (pairs: DuplicatePair[]) => DuplicatePair[]) => void;
  /** Serialize the normalized file (selected passes only) in the worker. */
  runNormalizeText: (options: NormalizeOptions, onText: (text: string) => void, onError?: () => void) => void;
}

interface Pending {
  /** Set for the cached scans, so a refresh can supersede its predecessor. */
  kind?: ScanKind;
  onResult: (data: ToolsResultMap[keyof ToolsResultMap]) => void;
  onProgress?: (done: number, total: number) => void;
  onError?: (message: string) => void;
}

/**
 * Owns the tools worker and the results of the whole-file Tools scans.
 *
 * Lives in `ToolsView` (which stays mounted across mode switches) rather than
 * in the per-sub-tab panels, so results survive tab switches and an in-flight
 * scan keeps running when the user browses elsewhere and comes back.
 *
 * The dataset is structured-cloned into the worker — a multi-second,
 * main-thread cost on an index-scale file — so the upload happens once per
 * content version, not per scan: the worker caches it, and it is re-sent only
 * when the dataset object is replaced (file load, save rebuild) or
 * `editVersionRef` says its contents changed. The ref is bumped synchronously
 * by every dataset mutation, so a fix followed by an immediate `refresh()`
 * re-validates against the just-fixed data.
 */
export function useToolsScans(dataset: Dataset, editVersionRef: { readonly current: number }): ToolsScans {
  const [states, setStates] = useState<ScanStates>(ALL_IDLE);
  // The source-reshape and normalize scans depend on the user's format
  // overrides (the report must match what the apply writes). Kept in a ref so
  // the stable callbacks below always read the current value; the overrides
  // fingerprint joins those scans' freshness key, so a settings change
  // re-scans.
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const formatOverridesRef = useRef(settings.formatOverrides);
  formatOverridesRef.current = settings.formatOverrides;
  const overridesSalt = (kind: ScanKind) => {
    const o = formatOverridesRef.current;
    return (SALT_KEYS[kind] ?? []).map((k) => o[k] ?? "").join("|");
  };
  // Mirror for same-tick reads (`ensure` guards against double starts before
  // the state update has rendered).
  const statesRef = useRef(states);
  statesRef.current = states;
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const nextIdRef = useRef(1);
  /** Content version currently cached in the worker; null when none is. */
  const uploadedKeyRef = useRef<string | null>(null);
  /** Bumped when the dataset *object* is replaced (load / save rebuild). */
  const datasetSeqRef = useRef(0);
  const datasetRef = useRef(dataset);

  /** Set on unmount so an already-scheduled deferred post doesn't respawn the
   *  worker after the hook is gone. */
  const disposedRef = useRef(false);

  const terminate = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    uploadedKeyRef.current = null;
    pendingRef.current.clear();
  }, []);

  // A replaced dataset invalidates every cached result and any running scan.
  useEffect(() => {
    if (dataset === datasetRef.current) return;
    datasetRef.current = dataset;
    datasetSeqRef.current += 1;
    terminate();
    statesRef.current = ALL_IDLE;
    setStates(ALL_IDLE);
  }, [dataset, terminate]);

  useEffect(() => {
    // Reset on (re)mount — StrictMode runs this cleanup once during its
    // double-mount, and a stuck `disposed` would silently drop every scan.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      terminate();
    };
  }, [terminate]);

  const setScan = useCallback((kind: ScanKind, value: ScanStates[ScanKind]) => {
    setStates((s) => ({ ...s, [kind]: value }));
  }, []);

  /** Post a request, re-feeding the worker the current dataset if what it has
   *  cached (if anything) is a different content version. */
  const post = useCallback(
    (req: Exclude<ToolsRequest, { type: "setDataset" }>, pending: Pending) => {
      if (!workerRef.current) {
        const worker = new Worker(new URL("../worker/tools.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (e: MessageEvent<ToolsResponse>) => {
          const res = e.data;
          const p = pendingRef.current.get(res.requestId);
          if (!p) return; // superseded — drop the late reply
          if (res.type === "progress") {
            p.onProgress?.(res.done, res.total);
            return;
          }
          pendingRef.current.delete(res.requestId);
          if (res.type === "error") {
            if (p.onError) p.onError(res.message);
            else console.error(`tools worker: ${res.message}`);
          } else {
            p.onResult(res.data);
          }
        };
        // The worker died outside a request handler (uncaught throw) or a
        // message failed to (de)serialize — no per-request `error` response is
        // coming, so fail every waiter or their scans would spin forever.
        const fail = (message: string) => {
          if (workerRef.current !== worker) return; // late event from a replaced worker
          const waiting = [...pendingRef.current.values()];
          terminate(); // worker state is unknown; the next scan respawns fresh
          for (const p of waiting) {
            if (p.onError) p.onError(message);
            else console.error(`tools worker: ${message}`);
          }
        };
        worker.onerror = (e: ErrorEvent) => fail(e.message || "The background worker failed.");
        worker.onmessageerror = () => fail("The background worker sent an unreadable message.");
        workerRef.current = worker;
      }
      const key = `${datasetSeqRef.current}:${editVersionRef.current}`;
      if (uploadedKeyRef.current !== key) {
        workerRef.current.postMessage({ type: "setDataset", dataset: datasetRef.current });
        uploadedKeyRef.current = key;
      }
      pendingRef.current.set(req.requestId, pending);
      workerRef.current.postMessage(req);
    },
    [editVersionRef, terminate],
  );

  /** Content version each scan's latest result was computed against. */
  const scanKeysRef = useRef(new Map<ScanKind, string>());
  /** Freshness key: dataset content, plus the format overrides for the scan
   *  whose result depends on them. */
  const scanKey = useCallback(
    (kind: ScanKind) =>
      `${datasetSeqRef.current}:${editVersionRef.current}` + (SALT_KEYS[kind] ? `:${overridesSalt(kind)}` : ""),
    [editVersionRef],
  );

  const start = useCallback(
    (kind: ScanKind) => {
      scanKeysRef.current.set(kind, scanKey(kind));
      statesRef.current = { ...statesRef.current, [kind]: { status: "running" } };
      setScan(kind, { status: "running" });
      // Defer the post one macrotask so React paints the spinner first: when
      // the worker's dataset copy is stale, `post` structured-clones the whole
      // file — seconds of blocked main thread on an index-scale dataset — and
      // an effect can run before the browser has painted the "running" state.
      setTimeout(() => {
        // Dropped meanwhile: cancelled, dataset replaced, or hook unmounted.
        if (disposedRef.current || statesRef.current[kind].status !== "running") return;
        // Supersede a pending scan of the same kind (refresh while running).
        for (const [id, p] of pendingRef.current) {
          if (p.kind === kind) pendingRef.current.delete(id);
        }
        const requestId = nextIdRef.current++;
        post(
          kind === "sourceReshape"
            ? { type: "sourceReshape", requestId, formatOverrides: formatOverridesRef.current }
            : kind === "normalize"
              ? { type: "normalizePreview", requestId, formatOverrides: formatOverridesRef.current }
              : { type: REQUEST_TYPE[kind], requestId },
          {
            kind,
            onResult: (data) => {
              if (kind === "validate") {
                setScan("validate", { status: "done", result: data as ToolsResultMap["validate"] });
              } else if (kind === "duplicates") {
                setScan("duplicates", { status: "done", result: (data as ToolsResultMap["findDuplicates"]).pairs });
              } else if (kind === "normalize") {
                setScan("normalize", { status: "done", result: (data as ToolsResultMap["normalizePreview"]).report });
              } else if (kind === "sourceReshape") {
                setScan("sourceReshape", { status: "done", result: (data as ToolsResultMap["sourceReshape"]).report });
              } else {
                setScan("sourceDuplicates", { status: "done", result: (data as ToolsResultMap["sourceDuplicates"]).report });
              }
            },
            onProgress:
              kind === "duplicates"
                ? (done, total) =>
                    setStates((s) =>
                      s.duplicates.status === "running"
                        ? { ...s, duplicates: { status: "running", progress: { done, total } } }
                        : s,
                    )
                : undefined,
            onError: (message) => setScan(kind, { status: "error", message }),
          },
        );
      }, 0);
    },
    [post, setScan, scanKey],
  );

  const ensure = useCallback(
    (kind: ScanKind) => {
      if (statesRef.current[kind].status !== "idle") return;
      start(kind);
    },
    [start],
  );

  const ensureFresh = useCallback(
    (kind: ScanKind) => {
      const status = statesRef.current[kind].status;
      if (status === "running") return;
      if (status !== "idle" && scanKeysRef.current.get(kind) === scanKey(kind)) return;
      start(kind);
    },
    [start, scanKey],
  );

  const refresh = useCallback((kind: ScanKind) => start(kind), [start]);

  // Read at render time (the keys live in refs, not state): an in-place edit
  // bumps `editVersionRef` without re-rendering the Tools panels, but coming
  // back to the tab re-renders them, which is exactly when this is consulted.
  const isStale = useCallback(
    (kind: ScanKind) => {
      const status = statesRef.current[kind].status;
      if (status === "idle" || status === "running") return false;
      return scanKeysRef.current.get(kind) !== scanKey(kind);
    },
    [scanKey],
  );

  const cancelDuplicates = useCallback(() => {
    // Terminating is the only way to stop the synchronous scan. Other pending
    // scans die with the worker — put them back to idle so `ensure` restarts
    // them the next time their panel shows.
    terminate();
    setStates((s) => {
      const back = <T,>(v: AsyncState<T>): AsyncState<T> => (v.status === "running" ? { status: "idle" } : v);
      const next: ScanStates = {
        validate: back(s.validate),
        duplicates: { status: "cancelled" },
        normalize: back(s.normalize),
        sourceDuplicates: back(s.sourceDuplicates),
        sourceReshape: back(s.sourceReshape),
      };
      statesRef.current = next;
      return next;
    });
  }, [terminate]);

  const updateDuplicates = useCallback((fn: (pairs: DuplicatePair[]) => DuplicatePair[]) => {
    setStates((s) =>
      s.duplicates.status === "done"
        ? { ...s, duplicates: { status: "done", result: fn(s.duplicates.result) } }
        : s,
    );
  }, []);

  const runNormalizeText = useCallback(
    (options: NormalizeOptions, onText: (text: string) => void, onError?: () => void) => {
      // Same paint-first deferral as start(): the post may re-upload the file.
      setTimeout(() => {
        if (disposedRef.current) return;
        const requestId = nextIdRef.current++;
        post(
          { type: "normalizeText", requestId, options, formatOverrides: formatOverridesRef.current },
          {
            onResult: (data) => onText((data as ToolsResultMap["normalizeText"]).text),
            onError: (message) => {
              console.error(`tools worker: ${message}`);
              onError?.();
            },
          },
        );
      }, 0);
    },
    [post],
  );

  return useMemo(
    () => ({ ...states, ensure, ensureFresh, refresh, isStale, cancelDuplicates, updateDuplicates, runNormalizeText }),
    [states, ensure, ensureFresh, refresh, isStale, cancelDuplicates, updateDuplicates, runNormalizeText],
  );
}
