import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { CandidateDecision } from "../review/types";
import { countDistinctPlaces } from "../tools/places";
import { useToolsScans } from "./useToolsScans";
import { ValidatePanel } from "./tools/ValidatePanel";
import { DuplicatesPanel } from "./tools/DuplicatesPanel";
import { NormalizePanel } from "./tools/NormalizePanel";
import { PrivacyPanel } from "./tools/PrivacyPanel";
import { SourcesPanel } from "./tools/SourcesPanel";
import { PlacesPanel } from "./tools/PlacesPanel";

type Tool = "validate" | "duplicates" | "normalize" | "privacy" | "sources" | "places";

const TOOLS: Tool[] = ["validate", "duplicates", "normalize", "privacy", "sources", "places"];

interface Props {
  /** The live main dataset — every tool operates on the whole file. */
  dataset: Dataset;
  /** Content version of the dataset, bumped synchronously on every mutation —
   *  tells the scans cache when the worker's copy of the file is stale. */
  editVersionRef: { readonly current: number };
  /** Main file name, used to name the normalized download. */
  fileName: string;
  /** Jump to a person/family record in Edit mode. */
  onNavigate: (id: string) => void;
  /** True when the Tools tab is the visible mode. */
  active: boolean;
  /** Rename a place segment in the given records and push to the undo stack. */
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
  /** Remove all broken family pointers and push to the undo stack. Returns the
   *  number of records changed, so the panel can re-validate and report. */
  onFixBrokenLinks: () => number;
  /** Infer SEX from family role for unspecified spouses and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate. */
  onFixSexFromRole: () => number;
  /** Repair safely-fixable unparseable dates (stray whitespace) and push to the
   *  undo stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDates: () => number;
  /** Remove redundant duplicate CHIL/FAMS/FAMC pointer lines and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDuplicatePointers: () => number;
  /** Merge a duplicate pair: fold the removed record into the survivor (kept)
   *  per the field choices, mutating the dataset in place and pushing to undo.
   *  Returns true when the merge applied (records changed). */
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
  /** Rejected within-file duplicate pairs (keyed by `duplicatePairKey`), persisted
   *  so a re-run of the duplicate scan doesn't resurface them. */
  rejectedDuplicates: Set<string>;
  /** Dismiss a pair as not-a-duplicate; persisted across scan re-runs. */
  onRejectDuplicate: (aId: string, bId: string) => void;
  /** Undo a previous reject, so the pair reappears in the active list. */
  onUnrejectDuplicate: (aId: string, bId: string) => void;
}

export function ToolsView({ dataset, editVersionRef, fileName, onNavigate, active, onApplyPlaceRename, onFixBrokenLinks, onFixSexFromRole, onFixDates, onFixDuplicatePointers, onMergeDuplicate, rejectedDuplicates, onRejectDuplicate, onUnrejectDuplicate }: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>("validate");
  // One shared worker runs the heavy whole-file scans off the main thread;
  // the results live here (not in the panels) so switching sub-tabs or modes
  // neither restarts a scan nor loses a finished one.
  const scans = useToolsScans(dataset, editVersionRef);

  // Cheap whole-file counts for the header overview; recomputed only per dataset.
  const stats = useMemo(() => ({
    indi: dataset.individuals.size,
    fam: dataset.families.size,
    sources: dataset.records.filter((r) => r.tag === "SOUR" && r.xref).length,
    media: dataset.records.filter((r) => r.tag === "OBJE" && r.xref).length,
    places: countDistinctPlaces(dataset),
  }), [dataset]);

  return (
    <div className="tools-view">
      <div className="tools-head">
        <p className="tools-stats">{t("tools.stats", stats)}</p>
      </div>
      <div className="tools-subtabs" role="tablist">
        {TOOLS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tool === id}
            className={`tools-tab ${tool === id ? "active" : ""}`}
            onClick={() => setTool(id)}
          >
            <span className="tools-tab-label">{t(`tools.tool.${id}`)}</span>
            <span className="tools-tab-desc">{t(`tools.tool.${id}.desc`)}</span>
          </button>
        ))}
      </div>
      <div className="tools-panel">
        {tool === "validate" && (
          <ValidatePanel dataset={dataset} scans={scans} onNavigate={onNavigate} active={active} onFixBrokenLinks={onFixBrokenLinks} onFixSexFromRole={onFixSexFromRole} onFixDates={onFixDates} onFixDuplicatePointers={onFixDuplicatePointers} />
        )}
        {tool === "duplicates" && (
          <DuplicatesPanel dataset={dataset} scans={scans} onNavigate={onNavigate} active={active} onMergeDuplicate={onMergeDuplicate} rejectedDuplicates={rejectedDuplicates} onRejectDuplicate={onRejectDuplicate} onUnrejectDuplicate={onUnrejectDuplicate} />
        )}
        {tool === "normalize" && (
          <NormalizePanel dataset={dataset} scans={scans} fileName={fileName} active={active} />
        )}
        {tool === "privacy" && (
          <PrivacyPanel dataset={dataset} fileName={fileName} onNavigate={onNavigate} active={active} />
        )}
        {tool === "sources" && (
          <SourcesPanel dataset={dataset} scans={scans} fileName={fileName} onNavigate={onNavigate} active={active} />
        )}
        {tool === "places" && (
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} onApplyPlaceRename={onApplyPlaceRename} />
        )}
      </div>
    </div>
  );
}
