import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../gedcom/types";
import type { CandidateDecision } from "../review/types";
import { countDistinctPlaces } from "../tools/places";
import type { AddressRename } from "../tools/addresses";
import { useToolsScans } from "./useToolsScans";
import { ValidatePanel } from "./tools/ValidatePanel";
import { DuplicatesPanel, type RelatedMerge } from "./tools/DuplicatesPanel";
import type { ClusterRelativeGroup } from "../tools/mergeCluster";
import { NormalizePanel } from "./tools/NormalizePanel";
import { PrivacyPanel } from "./tools/PrivacyPanel";
import { SourcesPanel } from "./tools/SourcesPanel";
import type { AddSourceResult } from "./AddSourceDialog";
import type { EditRepoFields, EditSourceFields } from "../gedcom/edit";
import type { MediaEditFields } from "./MediaViewer";
import { PlacesPanel } from "./tools/PlacesPanel";
import type { GeoAssignment, OfficialRename } from "../tools/geocode";
import type { BrokenLinkRef } from "../tools/fixLinks";
import type { BadDateRef } from "../tools/fixDates";
import type { DanglingRef } from "../tools/fixDanglingRefs";
import type { RecordPatch } from "./historyTypes";
import { PickerMenu } from "./PickerMenu";
import { usePhone } from "./usePhone";
import { ToolSummarySlotProvider } from "./tools/ToolSummary";

type Tool = "validate" | "duplicates" | "normalize" | "privacy" | "sources" | "places";

const TOOLS: Tool[] = ["places", "sources", "validate", "duplicates", "normalize", "privacy"];

interface Props {
  /** The live main dataset — every tool operates on the whole file. */
  dataset: Dataset;
  /** Content version of the dataset, bumped synchronously on every mutation —
   *  tells the scans cache when the worker's copy of the file is stale. */
  editVersionRef: { readonly current: number };
  /** Bumped on every committed edit batch, including undo/redo — panels
   *  whose scans walk the in-place-mutated dataset re-run off it. */
  editVersion: number;
  /** Main file name, used to name the normalized download. */
  fileName: string;
  /** Jump to a person/family record in Edit mode. */
  onNavigate: (id: string) => void;
  /** Create a standalone `SOUR` record (cited by nothing yet) from the Add
   * Source dialog's confirmed fields and push to the undo stack. */
  onAddSource: (fields: AddSourceResult) => void;
  /** Write edited fields to an existing `SOUR` record and push to the undo stack. */
  onEditSource: (sourceXref: string, fields: EditSourceFields) => void;
  /** Delete an uncited `SOUR` record (and its orphaned page media) and push to
   *  the undo stack. */
  onRemoveSource: (sourceXref: string) => void;
  /** Write a `REPO` record's fields and push to the undo stack. */
  onEditRepo: (repoXref: string, fields: EditRepoFields) => void;
  /** Write the viewer-edited fields of a shared `OBJE` record and push to the
   *  undo stack. */
  onEditMediaInfo: (objeXref: string, fields: MediaEditFields) => void;
  /** True when the Tools tab is the visible mode. */
  active: boolean;
  /** Rename a place segment in the given records and push to the undo stack. */
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
  /** Write reviewed geocode coordinates (raw PLAC value → coordinate) into the
   *  matching PLAC nodes and push to the undo stack; returns records changed. */
  onApplyGeocode: (assignments: Map<string, GeoAssignment>) => number;
  onApplyAddressCoords: (assignments: Map<string, GeoCoord>) => number;
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
  /** Batched "take the official name" renames — one undoable step. */
  onApplyOfficialNames: (renames: OfficialRename[]) => number;
  /** Rename houses' addresses on every event that carries them — a list, so a
   *  bulk take from the register lands as one undoable step. */
  onRenameAddresses: (renames: AddressRename[]) => number;
  onMovePlaceForAddresses: (keys: Set<string>, toPlace: string, coord?: GeoAssignment) => number;
  /** The app-wide start person, for kinship labels in people lists. */
  startId?: string;
  /** Remove broken family pointers — all of them, or the single one named by
   *  `only` (one finding's own fix) — and push to the undo stack. Returns the
   *  number of records changed, so the panel can re-validate and report. */
  onFixBrokenLinks: (only?: BrokenLinkRef) => number;
  /** Infer SEX from family role for unspecified spouses and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate.
   *  Every fix below takes the same `only` shape as the links one: the whole
   *  file, or the single record one finding's own row names. */
  onFixSexFromRole: (only?: string) => number;
  /** Put the two spouses of a family back in their own slots where they hold each
   *  other's, and push to the undo stack. Returns the number of records changed,
   *  so the panel can re-validate. */
  onFixSwappedRoles: (only?: string) => number;
  /** Repair safely-fixable unparseable dates (stray whitespace) and push to the
   *  undo stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDates: (only?: BadDateRef) => number;
  /** Remove redundant duplicate CHIL/FAMS/FAMC pointer lines and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDuplicatePointers: (only?: string) => number;
  /** Remove pointer lines whose target record is missing (citations, notes,
   *  media, nested family links) and push to the undo stack. Returns the number
   *  of records changed, so the panel can re-validate. */
  onFixDanglingRefs: (only?: DanglingRef) => number;
  onFillPlaceCoords: () => number;
  /** Apply a batch action's patches (Normalize & batch → Batch actions) as one
   *  undo entry; returns the patch count. */
  onApplyBatchPatches: (patches: RecordPatch[]) => number;
  /** Merge a duplicate pair: fold the removed record into the survivor (kept)
   *  per the field choices, mutating the dataset in place and pushing to undo.
   *  Returns true when the merge applied (records changed). */
  onMergeDuplicate: (
    survivorId: string,
    removedId: string,
    decision: CandidateDecision,
    /** Relatives the user ticked to merge first — see `mergeDuplicateChain`. */
    alsoMerge: RelatedMerge[],
  ) => boolean;
  /** Collapse a whole cluster — one person entered N times — into a single
   *  record, along with any relative groups the user ticked, as one undo entry.
   *  Returns the ids it removed (empty when nothing applied). */
  onMergeCluster: (
    survivorId: string,
    memberIds: string[],
    groups: ClusterRelativeGroup[],
  ) => string[];
  /** Rejected within-file duplicate pairs (keyed by `duplicatePairKey`), persisted
   *  so a re-run of the duplicate scan doesn't resurface them. */
  rejectedDuplicates: Set<string>;
  /** Dismiss a pair as not-a-duplicate; persisted across scan re-runs. */
  onRejectDuplicate: (aId: string, bId: string) => void;
  /** Dismiss a whole cluster of pairs at once, as a single undoable step. */
  onRejectDuplicatesBulk: (pairs: Array<{ aId: string; bId: string }>) => void;
  /** Undo a previous reject, so the pair reappears in the active list. */
  onUnrejectDuplicate: (aId: string, bId: string) => void;
}

export function ToolsView({ dataset, editVersionRef, editVersion, fileName, onNavigate, onAddSource, onEditSource, onRemoveSource, onEditRepo, onEditMediaInfo, active, onApplyPlaceRename, onApplyGeocode, onApplyAddressCoords, onRenamePlaceValue, onApplyOfficialNames, onRenameAddresses, onMovePlaceForAddresses, startId, onFixBrokenLinks, onFixSexFromRole, onFixSwappedRoles, onFixDates, onFixDuplicatePointers, onFixDanglingRefs, onFillPlaceCoords, onApplyBatchPatches, onMergeDuplicate, onMergeCluster, rejectedDuplicates, onRejectDuplicate, onRejectDuplicatesBulk, onUnrejectDuplicate }: Props) {
  const { t } = useTranslation();
  // Places leads the tabs and is where most work starts, so it is what Tools
  // opens on; the choice then stands for the rest of the session.
  const [tool, setTool] = useState<Tool>("places");
  const phone = usePhone();
  // Set by a ref callback, so the panels re-render once it exists and can
  // portal their summary into it.
  const [summarySlot, setSummarySlot] = useState<HTMLElement | null>(null);
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
      {/* Six description-carrying cards filled a phone screen and a half before
          any result. A dropdown names the tool you are in and lists the rest,
          with the tool's own summary line beside it (see ToolSummary). */}
      {phone ? (
        <div className="tools-picker-row">
          <PickerMenu
            className="tools-subtabs-picker"
            label={t("mode.tools")}
            value={tool}
            onChange={setTool}
            items={TOOLS.map((id) => ({ key: id, label: t(`tools.tool.${id}`), title: t(`tools.tool.${id}.desc`) }))}
          />
          <div className="tools-summary-slot" ref={setSummarySlot} />
        </div>
      ) : (
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
      )}
      <ToolSummarySlotProvider value={phone ? summarySlot : null}>
      <div className="tools-panel">
        {tool === "validate" && (
          <ValidatePanel dataset={dataset} scans={scans} onNavigate={onNavigate} active={active} onFixBrokenLinks={onFixBrokenLinks} onFixSexFromRole={onFixSexFromRole} onFixSwappedRoles={onFixSwappedRoles} onFixDates={onFixDates} onFixDuplicatePointers={onFixDuplicatePointers} onFixDanglingRefs={onFixDanglingRefs} onFillPlaceCoords={onFillPlaceCoords} />
        )}
        {tool === "duplicates" && (
          <DuplicatesPanel dataset={dataset} scans={scans} onNavigate={onNavigate} active={active} onMergeDuplicate={onMergeDuplicate} onMergeCluster={onMergeCluster} rejectedDuplicates={rejectedDuplicates} onRejectDuplicate={onRejectDuplicate} onRejectDuplicatesBulk={onRejectDuplicatesBulk} onUnrejectDuplicate={onUnrejectDuplicate} />
        )}
        {tool === "normalize" && (
          <NormalizePanel dataset={dataset} scans={scans} fileName={fileName} active={active} editVersionRef={editVersionRef} onNavigate={onNavigate} onApplyPatches={onApplyBatchPatches} startId={startId} />
        )}
        {tool === "privacy" && (
          <PrivacyPanel dataset={dataset} fileName={fileName} onNavigate={onNavigate} active={active} />
        )}
        {tool === "sources" && (
          <SourcesPanel dataset={dataset} scans={scans} fileName={fileName} onNavigate={onNavigate} onAddSource={onAddSource} onEditSource={onEditSource} onRemoveSource={onRemoveSource} onEditRepo={onEditRepo} onEditMediaInfo={onEditMediaInfo} active={active} />
        )}
        {tool === "places" && (
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} editVersion={editVersion} onApplyPlaceRename={onApplyPlaceRename} onApplyGeocode={onApplyGeocode} onApplyAddressCoords={onApplyAddressCoords} onRenamePlaceValue={onRenamePlaceValue} onApplyOfficialNames={onApplyOfficialNames} onRenameAddresses={onRenameAddresses} onMovePlaceForAddresses={onMovePlaceForAddresses} startId={startId} />
        )}
      </div>
      </ToolSummarySlotProvider>
    </div>
  );
}
