import { Fragment, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../locales/i18n";
import type { GedNode } from "../gedcom/types";
import { firstChild } from "../gedcom/node";
import type { SlotState } from "../App";
import { useMediaFolder } from "./MediaFolderContext";
import { revealEdgeWhitespace } from "./whitespace";
import { ConfirmDialog } from "./ConfirmDialog";
import { mediaOfferSuppressed, suppressMediaOffer } from "./mediaPrefs";
import { pickFile, fileFromDrop, supportsFilePicker, type AcceptSpec } from "./filePicker";

function countLocalMedia(records: GedNode[]): number {
  let n = 0;
  for (const rec of records) {
    if (rec.tag !== "OBJE") continue;
    const val = firstChild(rec, "FILE")?.value?.trim();
    if (val && !/^(https?:\/\/|www\.)/i.test(val)) n++;
  }
  return n;
}

// Survives remounts: this component is torn down whenever the full-page
// Compare/Edit tree takes over, so a component ref would reset and re-offer
// each time the user returns to Merge. A module-level slot persists for the
// session instead, so each loaded file is offered at most once.
let offeredFor: string | null = null;

/** Always-mounted companion to GedcomLoader: detects local media in the main file
 *  and offers the photo-folder picker as soon as the file loads, regardless of
 *  whether the info panel (which contains GedcomLoader) is currently visible. */
export function AutoMediaOffer({ main }: { main: SlotState }) {
  const { t } = useTranslation();
  const { folderName, openFolder } = useMediaFolder();
  const [offerCount, setOfferCount] = useState<number | null>(null);

  useEffect(() => {
    if (main.status !== "loaded" || folderName) return;
    if (mediaOfferSuppressed()) return;
    const { fileName, dataset } = main.file;
    if (offeredFor === fileName) return;
    offeredFor = fileName;
    const n = countLocalMedia(dataset.records);
    if (n > 0) setOfferCount(n);
  }, [main, folderName]);

  if (offerCount === null) return null;
  // Three answers, no checkbox: connect now, not this time, or never again.
  // The Esc key and a click outside land on "Later" — the reversible one.
  return (
    <ConfirmDialog
      message={t("loader.mediaFolder.autoOffer", { count: offerCount })}
      confirmLabel={t("loader.mediaFolder.select")}
      cancelLabel={t("loader.mediaFolder.later")}
      defaultConfirm
      altLabel={t("loader.mediaFolder.neverAsk")}
      onAlt={() => { suppressMediaOffer(); setOfferCount(null); }}
      onConfirm={() => { setOfferCount(null); openFolder(); }}
      onCancel={() => setOfferCount(null)}
    />
  );
}

interface Props {
  title: string;
  state: SlotState;
  onLoad: (file: File, handle?: FileSystemFileHandle) => void;
  /** When set on a loaded slot, offers an "unload" button that removes the file. */
  onUnload?: () => void;
  /** Role colour applied to the loaded filename. */
  accent: "main" | "incoming";
  highlight?: boolean;
  tooltip?: string;
  /** Short description shown below the title before any file is loaded. */
  description?: string;
  /** Shows a "Verify" button next to the filename that re-checks the file
   *  against disk (only meaningful once a live handle was captured for it). */
  canVerify?: boolean;
  onVerify?: () => void;
}

export function GedcomLoader({ title, state, onLoad, onUnload, accent, highlight, tooltip, description, canVerify, onVerify }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { t } = useTranslation();
  const { folderName, openFolder, clearFolder } = useMediaFolder();

  const accept: AcceptSpec =
    accent === "incoming"
      ? { description: "GEDCOM or CSV files", mime: { "text/plain": [".ged", ".gedcom"], "text/csv": [".csv"] } }
      : { description: "GEDCOM files", mime: { "text/plain": [".ged", ".gedcom"] } };

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLoad(file);

    if (inputRef.current) inputRef.current.value = "";
  }

  async function browse() {
    if (!supportsFilePicker) {
      inputRef.current?.click(); // unsupported browser — fall back to the hidden input
      return;
    }
    const picked = await pickFile(accept);
    if (picked) onLoad(picked.file, picked.handle); // null = user cancelled — do nothing
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const picked = await fileFromDrop(e.dataTransfer);
    if (picked) onLoad(picked.file, picked.handle);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void browse();
    }
  }

  const loaded = state.status === "loaded";
  const showFolderButton = accent === "main" && loaded;

  const folderUi = showFolderButton ? (
    folderName ? (
      <span className="loader-media-folder">
        <span className="loader-media-folder-name" title={t("loader.mediaFolder.tooltip", { name: folderName })}>
          📁 {folderName}
        </span>
        <button
          className="loader-media-folder-clear"
          onClick={clearFolder}
          title={t("loader.mediaFolder.clear")}
          aria-label={t("loader.mediaFolder.clear")}
        >
          ✕
        </button>
      </span>
    ) : (
      <button
        className="loader-media-folder-btn"
        onClick={() => openFolder()}
        title={t("loader.mediaFolder.tooltip.empty")}
      >
        📁 {t("loader.mediaFolder")}
      </button>
    )
  ) : null;

  return (
    <section className="loader">
      <div className="loader-head">
        <h2>{title}</h2>
      </div>
      {description && state.status === "empty" && (
        <p className="loader-desc" dangerouslySetInnerHTML={{ __html: description }} />
      )}

      {state.status === "loading" && (
        <div className="summary">
          <div className="parsing-status">
            <span className="spinner" aria-hidden="true" />
            {t("loader.parsing", { fileName: state.fileName })}
          </div>
        </div>
      )}

      {(state.status === "loaded" || state.status === "error") && (
        <div className="summary">{renderSummary(state, accent, t, folderUi, onUnload, canVerify, onVerify)}</div>
      )}

      {state.status !== "loading" && (
        <div
          className={`dropzone${dragging ? " dragover" : ""}${highlight ? " highlight" : ""}${loaded ? " compact" : ""}`}
          role="button"
          tabIndex={0}
          title={tooltip}
          onClick={() => void browse()}
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            className="file-input"
            type="file"
            accept={accent === "incoming" ? ".ged,.gedcom,.csv,text/plain,text/csv" : ".ged,.gedcom,text/plain"}
            onChange={onChange}
            onClick={(e) => e.stopPropagation()}
          />
          {loaded ? (
            <span className="dropzone-text">{t("loader.dropReplace")}</span>
          ) : (
            <>
              <svg
                className="dropzone-icon"
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 12 15 15" />
              </svg>
              <span className="dropzone-title">{t(accent === "main" ? "loader.dropMain" : "loader.dropIncoming")}</span>
              <span className="dropzone-hint">{t("loader.dropBrowse")}</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function renderSummary(
  state: Extract<SlotState, { status: "loaded" | "error" }>,
  accent: "main" | "incoming",
  t: Translate,
  folderUi: React.ReactNode,
  onUnload?: () => void,
  canVerify?: boolean,
  onVerify?: () => void,
): React.ReactNode {
  if (state.status === "error") {
    return <span className="error">{t("loader.error", { fileName: state.fileName, message: state.message })}</span>;
  }
  const { dataset, fileName, report, placeLayout, dateFormat, datePlaceholder, sourceLayout, pageMediaStyle, nameLayout, unknownNameStyle, coordUsage } = state.file;
  // Each row is one "Label: value" line; format rows carry a tooltip explaining
  // the (deliberately short) format label in detail.
  const info: { text: string; tooltip?: string }[] = [
    { text: t("loader.version", { version: dataset.version === "unknown" ? t("loader.versionUnknown") : dataset.version }) },
    { text: t("loader.encoding", { charset: dataset.charset }) },
  ];
  if (dateFormat) {
    // The unknown-component marker (e.g. "__") is appended to the tooltip rather
    // than the short label, mirroring how the name placeholder is explained.
    const tips = [t("loader.dateFormat.tip")];
    if (datePlaceholder) tips.push(t("loader.dateFormat.placeholderTip", { marker: datePlaceholder.repeat(2) }));
    info.push({ text: t("loader.dateFormat", { format: dateFormat }), tooltip: tips.join("\n") });
  }
  // Name format folds in the unknown-name convention: "inline"/"typed", plus
  // "+ placeholder" when the file marks unknown given/surnames with a token. The
  // layout and the exact marker are spelled out in the tooltip.
  if (nameLayout && nameLayout !== "none") {
    const parts = [t(`settings.format.names.${nameLayout}`)];
    const tips = [t(`nameLayout.${nameLayout}.tip`)];
    if (unknownNameStyle) {
      parts.push(t("loader.placeholderSuffix"));
      tips.push(t("loader.unknownNameTip", { token: unknownNameStyle }));
    }
    info.push({ text: t("loader.nameFormat", { format: parts.join(" + ") }), tooltip: tips.join("\n") });
  } else if (unknownNameStyle) {
    // No alternate names, but unknown names are still marked with a placeholder.
    info.push({
      text: t("loader.nameFormat", { format: t("loader.placeholderSuffix") }),
      tooltip: t("loader.unknownNameTip", { token: unknownNameStyle }),
    });
  }
  if (placeLayout && placeLayout !== "unknown") {
    info.push({ text: t("loader.placeFormat", { format: t(`settings.format.place.${placeLayout}`) }), tooltip: t(`placeLayout.${placeLayout}.tip`) });
  }
  // Whether the file uses coordinates at all, and how far they reach — the
  // signal for whether a geocoding pass is worth making.
  if (coordUsage && coordUsage.total > 0) {
    const { withCoord, total } = coordUsage;
    info.push({
      text:
        withCoord === 0
          ? t("loader.coords.none")
          : t("loader.coords", { withCoord, total, percent: Math.round((withCoord / total) * 100) }),
      tooltip: t("loader.coords.tip"),
    });
  }
  if (sourceLayout && sourceLayout !== "unknown") {
    // The page-media placement rides along when the file has page images at
    // all — "repository links · page images on events".
    const format = [t(`settings.format.sourceLayout.${sourceLayout}`), pageMediaStyle && t(`sourceLayout.pageMedia.${pageMediaStyle}`)]
      .filter(Boolean)
      .join(" · ");
    const tooltip = [t(`sourceLayout.${sourceLayout}.tip`), pageMediaStyle && t(`sourceLayout.pageMedia.${pageMediaStyle}.tip`)]
      .filter(Boolean)
      .join("\n");
    info.push({ text: t("loader.sourceFormat", { format }), tooltip });
  }
  info.push(
    { text: t("loader.individuals", { count: dataset.individuals.size }) },
    { text: t("loader.families", { count: dataset.families.size }) },
  );

  const warnings = dataset.warnings;
  const hasWarnings = warnings.length > 0;
  const warningTooltip = hasWarnings
    ? warnings.map((w) => (w.line != null ? `[${w.line}] ${w.message}` : w.message)).join("\n")
    : undefined;

  const examplesTooltip = (changes: { before: string; after: string }[]): string | undefined =>
    changes.length > 0
      ? changes.map((ex) => `${revealEdgeWhitespace(ex.before)} → ${revealEdgeWhitespace(ex.after)}`).join("\n")
      : undefined;

  const kv = info.map(({ text, tooltip }) => {
    const i = text.indexOf(":");
    const label = i >= 0 ? text.slice(0, i).trim() : text;
    const value = i >= 0 ? text.slice(i + 1).trim() : "";
    return { label, value, tooltip };
  });

  return (
    <>
      <div className="loader-filename-row">
        <div className={`gm-file ${accent} loader-filename`} title={`${t(accent === "main" ? "tree.main" : "tree.incoming")}: ${fileName}`}>{fileName}</div>
        {(canVerify || onUnload) && (
          <div className="loader-file-actions">
            {canVerify && onVerify && (
              <button className="loader-verify-btn" onClick={onVerify} title={t("load.verify.tooltip")}>
                {t("load.verify")}
              </button>
            )}
            {onUnload && (
              <button className="loader-unload-btn" onClick={onUnload} title={t("loader.unload.tooltip")}>
                {t("loader.unload")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="loader-cols">
        <div className="loader-info">
          <dl className="loader-meta">
            {kv.map(({ label, value, tooltip }) => (
              <Fragment key={label}>
                <dt title={tooltip}>{label}</dt>
                <dd title={tooltip}>{value}</dd>
              </Fragment>
            ))}
          </dl>
          <span className={hasWarnings ? "loader-warn alert" : "loader-warn ok"} title={warningTooltip}>
            {hasWarnings ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {t("loader.warnings", { count: warnings.length })}
          </span>
        </div>
        {!report && folderUi && (
          <div className="loader-report loader-media-col">
            <div className="loader-report-head">{t("loader.mediaFolder")}</div>
            {folderUi}
          </div>
        )}
        {report && (
          <div className="loader-report">
            <div className="loader-report-head">{t("loader.normalized")}</div>
            <dl className="loader-meta">
              {(
                [
                  ...(report.versionMigration
                    ? [[
                        t("loader.versionMigrated", {
                          count: report.versionMigration.changed,
                          // An undeclared version migrates as legacy 5.5.x.
                          from: report.versionMigration.from === "unknown" ? "5.5.x" : report.versionMigration.from,
                          to: report.versionMigration.to === "unknown" ? "5.5.x" : report.versionMigration.to,
                        }),
                        examplesTooltip(report.versionMigration.examples),
                      ] as [string, string | undefined]]
                    : []),
                  [t("loader.names", { count: report.nameVariantsReshaped }), examplesTooltip(report.nameVariantExamples)],
                  ...(report.unknownNamesReshaped
                    ? [[t("loader.unknownNames", { count: report.unknownNamesReshaped }), examplesTooltip(report.unknownNameExamples)] as [string, string | undefined]]
                    : []),
                  [t("loader.dates", { count: report.datesChanged }), examplesTooltip(report.dateExamples)],
                  [t("loader.places", { count: report.placesReshaped }), examplesTooltip(report.placeExamples)],
                  [t("loader.links", { count: report.linksConverted }), examplesTooltip(report.linkExamples)],
                  ...(report.vendorTagsRenamed
                    ? [[t("loader.vendorTags", { count: report.vendorTagsRenamed }), examplesTooltip(report.vendorTagExamples)] as [string, string | undefined]]
                    : []),
                  ...(report.consolidatedDuplicates
                    ? [[t("loader.consolidated", { count: report.consolidatedDuplicates }), t("loader.consolidated.tooltip")] as [string, string | undefined]]
                    : []),
                ] as [string, string | undefined][]
              ).map(([line, tooltip]) => {
                const i = line.indexOf(":");
                const label = i >= 0 ? line.slice(0, i).trim() : line;
                const value = i >= 0 ? line.slice(i + 1).trim() : "";
                return (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd className="loader-report-line" title={tooltip}>{value}</dd>
                  </Fragment>
                );
              })}
            </dl>
          </div>
        )}
      </div>
    </>
  );
}
