import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import type { NormalizeOptions } from "../../normalize/types";
import type { RecordPatch } from "../historyTypes";
import { downloadText, savedName } from "../download";
import { revealEdgeWhitespace } from "../whitespace";
import { type ToolsScans } from "../useToolsScans";
import { BatchSection } from "./BatchSection";
import { ToolsError, ToolsLoading } from "./shared";

/**
 * The "Normalize & batch" sub-tab: two mass-change surfaces behind one toggle —
 * the batch-actions workbench (filter people → apply one action, undoable) and
 * the whole-file style normalization (preview → download). Both stay mounted so
 * switching sections loses neither the built filter nor the scan preview.
 */
export function NormalizePanel({
  dataset,
  scans,
  fileName,
  active,
  editVersionRef,
  onNavigate,
  onApplyPatches,
  startId,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  fileName: string;
  active: boolean;
  editVersionRef: { readonly current: number };
  onNavigate: (id: string) => void;
  onApplyPatches: (patches: RecordPatch[]) => number;
  startId?: string;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<"batch" | "normalize">("batch");
  return (
    <>
      <div className="batch-section-toggle" role="tablist">
        {(["batch", "normalize"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={section === s}
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
        <NormalizeFileSection dataset={dataset} scans={scans} fileName={fileName} active={active && section === "normalize"} />
      </div>
    </>
  );
}

function NormalizeFileSection({ dataset, scans, fileName, active }: { dataset: Dataset; scans: ToolsScans; fileName: string; active: boolean }) {
  const { t } = useTranslation();
  // The preview report comes from the ToolsView-level worker scan cache.
  const state = scans.normalize;
  // Which passes the user wants applied on download; the preview report above
  // always reflects all three so the counts show what each would change.
  // stripInternal starts unchecked: it is the one deliberately lossy pass.
  const [selected, setSelected] = useState<NormalizeOptions>({ dates: true, places: true, links: true, names: true, vendorTags: true, sourceCoverage: true, noteShape: false, stripInternal: false });
  // True while the worker serializes the selected passes for download.
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setSelected({ dates: true, places: true, links: true, names: true, vendorTags: true, sourceCoverage: true, noteShape: false, stripInternal: false });
    setDownloading(false);
  }, [dataset]);

  // Run the preview in the tools worker the first time the tab is shown; the
  // result lives in the ToolsView-level cache, so revisits are instant.
  // `ensureFresh` rather than `ensure`: the report is what Download will write,
  // so a format choice made in Settings since it ran must re-run it — a cached
  // report showing the old house style would be a lie about the download.
  useEffect(() => {
    if (active) scans.ensureFresh("normalize");
  }, [active, scans]);

  function download() {
    if (downloading) return;
    setDownloading(true);
    // The worker re-runs only the selected passes and serializes the result,
    // so just the finished text crosses back to the main thread.
    scans.runNormalizeText(
      selected,
      (text) => {
        setDownloading(false);
        downloadText(savedName(fileName, "ged"), text);
      },
      () => setDownloading(false),
    );
  }

  if (state.status === "error") return <ToolsError message={state.message} />;
  if (state.status !== "done") return <ToolsLoading label={t("tools.normalize.running")} />;

  return (
    <>
      {state.status === "done" && (() => {
        const report = state.result;
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted + report.nameVariantsReshaped + report.unknownNamesReshaped + report.vendorTagsRenamed + (report.coverageReshaped ?? 0) + (report.notesReshaped ?? 0) + report.internalStripped;
        if (changed === 0) return <p className="tools-clean tools-clean--ok">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
          // The "names" pass also cleans unknown-name placeholders (NN, ____).
          names: report.nameVariantsReshaped + report.unknownNamesReshaped,
          vendorTags: report.vendorTagsRenamed,
          sourceCoverage: report.coverageReshaped ?? 0,
          noteShape: report.notesReshaped ?? 0,
          stripInternal: report.internalStripped,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the download: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0) +
          (selected.names ? counts.names : 0) +
          (selected.vendorTags ? counts.vendorTags : 0) +
          (selected.sourceCoverage ? counts.sourceCoverage : 0) +
          (selected.noteShape ? counts.noteShape : 0) +
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
            {selected.stripInternal && <NormExamples title={t("tools.normalize.exStripInternal")} examples={report.internalExamples} />}
            <button className="nav-btn tools-run" onClick={download} disabled={selectedChanges === 0 || downloading}>
              {t("tools.normalize.download")}
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

function NormExamples({ title, examples }: { title: string; examples: { before: string; after: string }[] }) {
  if (!examples.length) return null;
  return (
    <div className="tools-examples">
      <div className="tools-examples-title">{title}</div>
      <ul>
        {examples.map((e, i) => (
          <li key={i}>
            <span className="tools-ex-from">{revealEdgeWhitespace(e.before)}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{revealEdgeWhitespace(e.after)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
