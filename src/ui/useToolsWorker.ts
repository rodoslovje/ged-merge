import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "../worker/toolsMessages";

export interface ToolsWorker {
  /**
   * Start a scan in the tools worker; the handlers fire as it reports back.
   * Returns a cancel function. The worker runs each scan as one synchronous
   * pass, so cancelling the only pending request terminates the worker — the
   * sole way to actually stop the CPU work — and it respawns lazily on the
   * next run. Cancelling after delivery is a no-op.
   */
  run: <K extends ToolsRequest["type"]>(
    req: { type: K } & Omit<Extract<ToolsRequest, { type: K }>, "requestId" | "type">,
    onResult: (data: ToolsResultMap[K]) => void,
    onProgress?: (done: number, total: number) => void,
    onError?: (message: string) => void,
  ) => () => void;
}

interface Pending {
  onResult: (data: unknown) => void;
  onProgress?: (done: number, total: number) => void;
  onError?: (message: string) => void;
}

/**
 * Owns the tools worker's lifecycle: spawned lazily on the first run (the
 * Tools view stays mounted even when another mode is shown, so an eager
 * worker would mostly sit idle), responses correlated to callers by request
 * id. Requests ship the live dataset each time — a structured clone that
 * briefly costs the main thread, but guarantees the scan sees current data
 * and keeps the worker stateless (see `toolsMessages.ts`).
 */
export function useToolsWorker(): ToolsWorker {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const nextIdRef = useRef(1);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingRef.current.clear();
    },
    [],
  );

  const run = useCallback(
    <K extends ToolsRequest["type"]>(
      req: { type: K } & Omit<Extract<ToolsRequest, { type: K }>, "requestId" | "type">,
      onResult: (data: ToolsResultMap[K]) => void,
      onProgress?: (done: number, total: number) => void,
      onError?: (message: string) => void,
    ): (() => void) => {
      if (!workerRef.current) {
        const worker = new Worker(new URL("../worker/tools.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (e: MessageEvent<ToolsResponse>) => {
          const res = e.data;
          const pending = pendingRef.current.get(res.requestId);
          if (!pending) return; // cancelled — drop the late reply
          if (res.type === "progress") {
            pending.onProgress?.(res.done, res.total);
            return;
          }
          pendingRef.current.delete(res.requestId);
          if (res.type === "error") {
            if (pending.onError) pending.onError(res.message);
            else console.error(`tools worker: ${res.message}`);
          } else {
            pending.onResult(res.data);
          }
        };
        workerRef.current = worker;
      }
      const requestId = nextIdRef.current++;
      pendingRef.current.set(requestId, {
        onResult: (data) => onResult(data as ToolsResultMap[K]),
        onProgress,
        onError,
      });
      workerRef.current.postMessage({ ...req, requestId });
      return () => {
        if (!pendingRef.current.delete(requestId)) return; // already delivered
        // The worker can't interrupt its synchronous scan; with nothing else
        // pending, terminate it so the work actually stops. If another
        // request is still queued, just drop this one's reply instead.
        if (pendingRef.current.size === 0) {
          workerRef.current?.terminate();
          workerRef.current = null;
        }
      };
    },
    [],
  );

  return useMemo(() => ({ run }), [run]);
}
