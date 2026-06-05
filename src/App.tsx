import { useEffect, useRef, useState } from "react";
import type { Dataset } from "./gedcom/types";
import type { NormalizationReport } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import { GedcomLoader } from "./ui/GedcomLoader";

interface LoadedFile {
  fileName: string;
  dataset: Dataset;
  report?: NormalizationReport;
}

type SlotState =
  | { status: "empty" }
  | { status: "loading"; fileName: string }
  | { status: "loaded"; file: LoadedFile }
  | { status: "error"; fileName: string; message: string };

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const [master, setMaster] = useState<SlotState>({ status: "empty" });
  const [compare, setCompare] = useState<SlotState>({ status: "empty" });

  useEffect(() => {
    const worker = new Worker(new URL("./worker/gedcom.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const setter = msg.role === "master" ? setMaster : setCompare;
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        setter({ status: "loaded", file });
      } else {
        setter({ status: "error", fileName: msg.fileName, message: msg.message });
      }
    };

    return () => worker.terminate();
  }, []);

  async function loadFile(role: DatasetRole, file: File) {
    const setter = role === "master" ? setMaster : setCompare;
    setter({ status: "loading", fileName: file.name });
    const buffer = await file.arrayBuffer();
    workerRef.current?.postMessage(
      { type: "parse", role, fileName: file.name, buffer },
      [buffer], // transfer ownership — avoids copying large files
    );
  }

  return (
    <div className="app">
      <h1>GedMerge</h1>
      <p className="subtitle">
        Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded.
      </p>

      <div className="loaders">
        <GedcomLoader
          title="Master GEDCOM"
          state={master}
          onLoad={(f) => loadFile("master", f)}
        />
        <GedcomLoader
          title="Compare GEDCOM"
          state={compare}
          onLoad={(f) => loadFile("compare", f)}
        />
      </div>
    </div>
  );
}

export type { SlotState };
