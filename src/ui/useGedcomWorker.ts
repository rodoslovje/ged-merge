import { useCallback, useEffect, useRef } from "react";
import type { WorkerRequest, WorkerResponse } from "../worker/messages";

/**
 * Owns the GEDCOM Web Worker's lifecycle: creates it once on mount, terminates
 * it on unmount, and returns a stable `post` for sending requests (with an
 * optional transfer list, e.g. an ArrayBuffer to move rather than copy).
 *
 * Incoming messages are dispatched to `onMessage` via a ref, so the worker is
 * created exactly once yet always calls the *latest* handler — the caller can
 * define `onMessage` inline (closing over current state/setters) without
 * re-creating the worker on every render.
 */
export function useGedcomWorker(
  onMessage: (msg: WorkerResponse) => void,
): {
  post: (msg: WorkerRequest, transfer?: Transferable[]) => void;
  /** Terminate the running worker and start a fresh one. Used to hard-abort an
   *  in-flight match (the worker can't interrupt its own synchronous scoring
   *  pass) when a new file supersedes it — the caller then re-feeds the slots. */
  reset: () => void;
} {
  const workerRef = useRef<Worker | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  const spawn = useCallback(() => {
    const worker = new Worker(new URL("../worker/gedcom.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => handlerRef.current(e.data);
    workerRef.current = worker;
  }, []);

  useEffect(() => {
    spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [spawn]);

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    spawn();
  }, [spawn]);

  const post = useCallback((msg: WorkerRequest, transfer?: Transferable[]) => {
    workerRef.current?.postMessage(msg, transfer ?? []);
  }, []);

  return { post, reset };
}
