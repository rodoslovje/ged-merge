import { useEffect, useRef, useState } from "react";
import type { Dataset } from "./gedcom/types";
import type { NormalizationReport } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import type { FamilyCandidate, IndividualCandidate, MatchResult } from "./match/types";
import { decisionKey, type CandidateDecision, type MatchKind } from "./review/types";
import { GedcomLoader } from "./ui/GedcomLoader";
import { HomePersonSelector } from "./ui/HomePersonSelector";
import { MatchResults } from "./ui/MatchResults";
import { ReviewPanel } from "./ui/ReviewPanel";

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
  const [matches, setMatches] = useState<MatchResult | null>(null);
  const [matching, setMatching] = useState(false);
  const [homeId, setHomeId] = useState<string | undefined>(undefined);
  const [decisions, setDecisions] = useState<Map<string, CandidateDecision>>(new Map());
  const [reviewing, setReviewing] = useState<{
    kind: MatchKind;
    candidate: IndividualCandidate | FamilyCandidate;
  } | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/gedcom.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "matching") {
        setMatching(true);
        return;
      }
      if (msg.type === "matched") {
        setMatches(msg.result);
        setMatching(false);
        return;
      }
      const setter = msg.role === "master" ? setMaster : setCompare;
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        setter({ status: "loaded", file });
        if (msg.role === "master") setHomeId(msg.suggestedHomeId);
      } else {
        setter({ status: "error", fileName: msg.fileName, message: msg.message });
      }
    };

    return () => worker.terminate();
  }, []);

  async function loadFile(role: DatasetRole, file: File) {
    const setter = role === "master" ? setMaster : setCompare;
    setter({ status: "loading", fileName: file.name });
    // Drop stale results + decisions; the worker will emit fresh matches once
    // both sides are (re)loaded and re-normalized.
    setMatches(null);
    setDecisions(new Map());
    setReviewing(null);
    const buffer = await file.arrayBuffer();
    workerRef.current?.postMessage(
      { type: "parse", role, fileName: file.name, buffer },
      [buffer], // transfer ownership — avoids copying large files
    );
  }

  function changeHome(id: string) {
    setHomeId(id);
    workerRef.current?.postMessage({ type: "setHome", id });
  }

  function updateDecision(
    kind: MatchKind,
    candidate: IndividualCandidate | FamilyCandidate,
    next: CandidateDecision,
  ) {
    const key = decisionKey(kind, candidate.masterId, candidate.compareId);
    setDecisions((prev) => new Map(prev).set(key, next));
  }

  const masterDataset = master.status === "loaded" ? master.file.dataset : undefined;
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;

  return (
    <div className="app">
      <h1>GedMerge</h1>
      <p className="subtitle">
        Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded.
      </p>

      <div className="loaders">
        <div className="loader-col">
          <GedcomLoader
            title="Master GEDCOM"
            state={master}
            onLoad={(f) => loadFile("master", f)}
          />
          {master.status === "loaded" && (
            <HomePersonSelector
              individuals={master.file.dataset.individuals}
              homeId={homeId}
              onChange={changeHome}
            />
          )}
        </div>
        <GedcomLoader
          title="Compare GEDCOM"
          state={compare}
          onLoad={(f) => loadFile("compare", f)}
        />
      </div>

      {matching && (
        <div className="matching" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Calculating matches…
        </div>
      )}

      {matches && !matching && (
        <MatchResults
          result={matches}
          decisions={decisions}
          onReview={(kind, candidate) => setReviewing({ kind, candidate })}
        />
      )}

      {reviewing && masterDataset && compareDataset && (
        <ReviewPanel
          kind={reviewing.kind}
          candidate={reviewing.candidate}
          masterDs={masterDataset}
          compareDs={compareDataset}
          decision={decisions.get(
            decisionKey(
              reviewing.kind,
              reviewing.candidate.masterId,
              reviewing.candidate.compareId,
            ),
          )}
          onChange={(next) => updateDecision(reviewing.kind, reviewing.candidate, next)}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

export type { SlotState };
