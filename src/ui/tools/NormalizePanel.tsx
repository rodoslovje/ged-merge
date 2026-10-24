import type { ToolView } from "../ToolsView";
import { useEffect, useState } from "react";
import { tabIndexFor, tablistKeyDown } from "../../keyboard/tablist";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import type { NormChange, NormalizeOptions } from "../../normalize/types";
import type { RecordPatch } from "../historyTypes";
import { applyBulkNormalize } from "../../tools/bulkNormalize";
import type { NormalizeRepairKind } from "../../tools/normalizeRepairs";
import { useFormatOverrides } from "../TargetFormatContext";
import { FIX_SUFFIX } from "./ValidatePanel";
import { revealEdgeWhitespace } from "../whitespace";
import { type ToolsScans } from "../useToolsScans";
import { BatchSection } from "./BatchSection";
import { ToolsError, ToolsLoading } from "./shared";

/**
 * The "Normalize & batch" sub-tab: two mass-change surfaces behind one toggle —
 * the batch-actions workbench (filter people → apply one action) and the
 * whole-file style normalization (preview → apply). Both stay mounted so
 * switching sections loses neither the built filter nor the scan preview. The
 * open section is the app's page (`view`), like any tool's: a page can be sent
 * straight to Normalize, and Back returns to the section left.
 */
export function NormalizePanel({
  dataset,
  scans,
  active,
  editVersionRef,
  onNavigate,
  onApplyPatches,
  startId,
  view,
  onViewChange,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  active: boolean;
  editVersionRef: { readonly current: number };
  onNavigate: (id: string) => void;
  onApplyPatches: (patches: RecordPatch[]) => number;
  startId?: string;
  view: ToolView;
  onViewChange: (view: ToolView) => void;
}) {
  const { t } = useTranslation();
  const section = view === "normalize" ? "normalize" : "batch";
  const setSection = (s: "batch" | "normalize") => onViewChange(s === "normalize" ? "normalize" : "tree");
  return (
    <>
      <div className="batch-section-toggle" role="tablist" onKeyDown={tablistKeyDown}>
        {(["batch", "normalize"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={section === s}
            tabIndex={tabIndexFor(section === s)}
            className={`batch-section-tab ${section === s ? "active" : ""}`}
            onClick={() => setSection(s)}
          >
            {t(`tools.batch.section.${s}`)}
          </button>
        ))}
      </div>
      <div style={{ display: section === "batch" ? undefined : "none" }}>
        <BatchSection
          dataset={dataset}
          editVersionRef={editVersionRef}
          active={active && section === "batch"}
          onNavigate={onNavigate}
          onApplyPatches={onApplyPatches}
          startId={startId}
        />
      </div>
      <div style={{ display: section === "normalize" ? undefined : "none" }}>
        <NormalizeFileSection dataset={dataset} scans={scans} active={active && section === "normalize"} onApplyPatches={onApplyPatches} />
      </div>
    </>
  );
}

/** The passes a fresh preview starts with: all but the two that are the
 *  reader's call — notes reshaped, and the deliberately lossy internal-tag strip. */
const DEFAULT_PASSES: NormalizeOptions = { dates: true, places: true, links: true, names: true, vendorTags: true, sourceCoverage: true, noteShape: false, repairs: true, stripInternal: false };

function NormalizeFileSection({ dataset, scans, active, onApplyPatches }: { dataset: Dataset; scans: ToolsScans; active: boolean; onApplyPatches: (patches: RecordPatch[]) => number }) {
  const { t } = useTranslation();
  const formatOverrides = useFormatOverrides();
  // The preview report comes from the ToolsView-level worker scan cache.
  const state = scans.normalize;
  // Which passes the user wants applied; the preview report above always
  // reflects all of them so the counts show what each would change.
  const [selected, setSelected] = useState<NormalizeOptions>(DEFAULT_PASSES);
  // After an apply: how many records it changed, until the next preview.
  const [applied, setApplied] = useState<number | null>(null);

  useEffect(() => {
    setSelected(DEFAULT_PASSES);
    setApplied(null);
  }, [dataset]);

  // Run the preview in the tools worker the first time the tab is shown; the
  // result lives in the ToolsView-level cache, so revisits are instant.
  // `ensureFresh` rather than `ensure`: the report is what Download will write,
  // so a format choice made in Settings since it ran must re-run it — a cached
  // report showing the old house style would be a lie about the download.
  useEffect(() => {
    if (active) scans.ensureFresh("normalize");
  }, [active, scans]);

  // The selected passes run on the live file, as one step; the save preview
  // then lists every change before anything is written.
  function apply() {
    setApplied(onApplyPatches(applyBulkNormalize(dataset, selected, formatOverrides)));
    scans.refresh("normalize");
  }

  if (state.status === "error") return <ToolsError message={state.message} />;
  if (state.status !== "done") return <ToolsLoading label={t("tools.normalize.running")} />;

  return (
    <>
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.normalize.applied", { count: applied })}</p>}
      {state.status === "done" && (() => {
        const report = state.result;
        const repairs = Object.entries(report.repairs ?? {}) as [NormalizeRepairKind, number][];
        const repairCount = repairs.reduce((n, [, c]) => n + c, 0);
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted + report.nameVariantsReshaped + report.unknownNamesReshaped + report.vendorTagsRenamed + (report.coverageReshaped ?? 0) + (report.notesReshaped ?? 0) + report.internalStripped + repairCount;
        if (changed === 0) return applied === null && <p className="tools-clean tools-clean--ok">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
          // The "names" pass also cleans unknown-name placeholders (NN, ____).
          names: report.nameVariantsReshaped + report.unknownNamesReshaped,
          vendorTags: report.vendorTagsRenamed,
          sourceCoverage: report.coverageReshaped ?? 0,
          noteShape: report.notesReshaped ?? 0,
          repairs: repairCount,
          stripInternal: report.internalStripped,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the apply: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0) +
          (selected.names ? counts.names : 0) +
          (selected.vendorTags ? counts.vendorTags : 0) +
          (selected.sourceCoverage ? counts.sourceCoverage : 0) +
          (selected.noteShape ? counts.noteShape : 0) +
          (selected.repairs ? counts.repairs : 0) +
          (selected.stripInternal ? counts.stripInternal : 0);
        return (
          <>
            <p className="tools-intro">{t("tools.normalize.intro")}</p>
            <ul className="tools-norm-summary">
              <NormCheck label={t("tools.normalize.dates", { count: counts.dates })}
                checked={selected.dates} count={counts.dates} onChange={() => toggle("dates")} />
              <NormCheck label={t("tools.normalize.places", { count: counts.places })}
                checked={selected.places} count={counts.places} onChange={() => toggle("places")} />
              <NormCheck label={t("tools.normalize.links", { count: counts.links })}
                checked={selected.links} count={counts.links} onChange={() => toggle("links")} />
              <NormCheck label={t("tools.normalize.names", { count: counts.names })}
                checked={selected.names} count={counts.names} onChange={() => toggle("names")} />
              <NormCheck label={t("tools.normalize.vendorTags", { count: counts.vendorTags })}
                checked={selected.vendorTags} count={counts.vendorTags} onChange={() => toggle("vendorTags")} />
              <NormCheck label={t("tools.normalize.sourceCoverage", { count: counts.sourceCoverage })}
                checked={!!selected.sourceCoverage} count={counts.sourceCoverage} onChange={() => toggle("sourceCoverage")} />
              <NormCheck label={t("tools.normalize.noteShape", { count: counts.noteShape })}
                checked={!!selected.noteShape} count={counts.noteShape} onChange={() => toggle("noteShape")} />
              <NormCheck label={t("tools.normalize.repairs", { count: counts.repairs })}
                checked={!!selected.repairs} count={counts.repairs} onChange={() => toggle("repairs")} />
              <NormCheck label={t("tools.normalize.stripInternal", { count: counts.stripInternal })}
                checked={!!selected.stripInternal} count={counts.stripInternal} onChange={() => toggle("stripInternal")} />
            </ul>
            {selected.dates && <NormExamples title={t("tools.normalize.exDates")} examples={report.dateExamples} />}
            {selected.places && <NormExamples title={t("tools.normalize.exPlaces")} examples={report.placeExamples} />}
            {selected.links && <NormExamples title={t("tools.normalize.exLinks")} examples={report.linkExamples} />}
            {selected.names && <NormExamples title={t("tools.normalize.exNames")} examples={[...report.nameVariantExamples, ...report.unknownNameExamples]} />}
            {selected.vendorTags && <NormExamples title={t("tools.normalize.exVendorTags")} examples={report.vendorTagExamples} />}
            {selected.sourceCoverage && <NormExamples title={t("tools.normalize.exSourceCoverage")} examples={report.coverageExamples ?? []} />}
            {selected.noteShape && <NormExamples title={t("tools.normalize.exNoteShape")} examples={report.noteShapeExamples ?? []} />}
            {selected.repairs && repairs.length > 0 && (
              // The health check's own buttons, as it words them.
              <div className="tools-examples">
                <div className="tools-examples-title">{t("tools.normalize.exRepairs")}</div>
                <ul>
                  {repairs.map(([kind, count]) => (
                    <li key={kind} data-tip={t(`tools.validate.fix${FIX_SUFFIX[kind]}Hint`)}>
                      {t(`tools.validate.fix${FIX_SUFFIX[kind]}`, { count })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {selected.stripInternal && <NormExamples title={t("tools.normalize.exStripInternal")} examples={report.internalExamples} />}
            <button data-busy-cursor className="nav-btn tools-run" onClick={apply} disabled={selectedChanges === 0}>
              {t("tools.normalize.apply")}
            </button>
          </>
        );
      })()}
    </>
  );
}

/** One selectable normalization-count row: a checkbox in front of the count.
 *  Passes with nothing to change are disabled — there is nothing to opt into. */
function NormCheck({
  label,
  checked,
  count,
  onChange,
}: {
  label: string;
  checked: boolean;
  count: number;
  onChange: () => void;
}) {
  return (
    <li>
      <label className={`tools-norm-check ${count === 0 ? "disabled" : ""}`}>
        <input type="checkbox" checked={checked && count > 0} disabled={count === 0} onChange={onChange} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function NormExamples({ title, examples }: { title: string; examples: NormChange[] }) {
  if (!examples.length) return null;
  return (
    <div className="tools-examples">
      <div className="tools-examples-title">{title}</div>
      <ul>
        {examples.map((e, i) => (
          <li key={i}>
            {/* The record the pair is a change to, where the fields alone do
                not name it — a source's title says what the proposed coverage
                was read from. */}
            {e.context && <span className="tools-ex-context">{e.context}</span>}
            <span className="tools-ex-from">{revealEdgeWhitespace(e.before)}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{revealEdgeWhitespace(e.after)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
