import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import type { DuplicatePair } from "../tools/duplicates";
import type { ValidationReport } from "../tools/validate";
import type { StructureReport } from "../tools/structure";
import type { DuplicateReport } from "../tools/sourceDuplicates";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "../worker/toolsMessages";

/** Lifecycle of one whole-file scan. */
export type AsyncState<T> =
  | { status: "idle" }
  | { status: "running"; progress?: { done: number; total: number } }
  | { status: "cancelled" }
  | { status: "error"; message: string }
  | { status: "done"; result: T };

/** The scans that cache their result here (all but the download serializer). */
type ScanKind = "validate" | "duplicates" | "normalize" | "sourceDuplicates";

interface ScanStates {
  validate: AsyncState<{ report: ValidationReport; structure: StructureReport }>;
  duplicates: AsyncState<DuplicatePair[]>;
  normalize: AsyncState<NormalizationReport>;
  sourceDuplicates: AsyncState<DuplicateReport>;
}

const ALL_IDLE: ScanStates = {
  validate: { status: "idle" },
  duplicates: { status: "idle" },
  normalize: { status: "idle" },
  sourceDuplicates: { status: "idle" },
};

/** Worker request type for each scan kind. */
const REQUEST_TYPE = {
  validate: "validate",
  duplicates: "findDuplicates",
  normalize: "normalizePreview",
  sourceDuplicates: "sourceDuplicates",
} as const;

export interface ToolsScans extends ScanStates {
  /** Start a scan unless it already ran (or is running) for this file. */
  ensure: (kind: ScanKind) => void;
  /** Re-run a scan against the current (possibly just-edited) dataset. */
  refresh: (kind: ScanKind) => void;
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

  useEffect(() => terminate, [terminate]);

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
    [editVersionRef],
  );

  const start = useCallback(
    (kind: ScanKind) => {
      // Supersede a pending scan of the same kind (refresh while running).
      for (const [id, p] of pendingRef.current) {
        if (p.kind === kind) pendingRef.current.delete(id);
      }
      statesRef.current = { ...statesRef.current, [kind]: { status: "running" } };
      setScan(kind, { status: "running" });
      const requestId = nextIdRef.current++;
      post(
        { type: REQUEST_TYPE[kind], requestId },
        {
          kind,
          onResult: (data) => {
            if (kind === "validate") {
              setScan("validate", { status: "done", result: data as ToolsResultMap["validate"] });
            } else if (kind === "duplicates") {
              setScan("duplicates", { status: "done", result: (data as ToolsResultMap["findDuplicates"]).pairs });
            } else if (kind === "normalize") {
              setScan("normalize", { status: "done", result: (data as ToolsResultMap["normalizePreview"]).report });
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
    },
    [post, setScan],
  );

  const ensure = useCallback(
    (kind: ScanKind) => {
      if (statesRef.current[kind].status !== "idle") return;
      start(kind);
    },
    [start],
  );

  const refresh = useCallback((kind: ScanKind) => start(kind), [start]);

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
      const requestId = nextIdRef.current++;
      post(
        { type: "normalizeText", requestId, options },
        {
          onResult: (data) => onText((data as ToolsResultMap["normalizeText"]).text),
          onError: (message) => {
            console.error(`tools worker: ${message}`);
            onError?.();
          },
        },
      );
    },
    [post],
  );

  return useMemo(
    () => ({ ...states, ensure, refresh, cancelDuplicates, updateDuplicates, runNormalizeText }),
    [states, ensure, refresh, cancelDuplicates, updateDuplicates, runNormalizeText],
  );
}
