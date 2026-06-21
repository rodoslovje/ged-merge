import { Fragment, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../locales/i18n";
import type { SlotState } from "../App";

interface Props {
  title: string;
  state: SlotState;
  onLoad: (file: File) => void;
  /** Role colour applied to the loaded filename. */
  accent: "master" | "incoming";
  highlight?: boolean;
  tooltip?: string;
  /** Short description shown below the title before any file is loaded. */
  description?: string;
}

export function GedcomLoader({ title, state, onLoad, accent, highlight, tooltip, description }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { t } = useTranslation();

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLoad(file);

    if (inputRef.current) inputRef.current.value = "";
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onLoad(file);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  const loaded = state.status === "loaded";

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
        <div className="summary">{renderSummary(state, accent, t)}</div>
      )}

      {state.status !== "loading" && (
        <div
          className={`dropzone${dragging ? " dragover" : ""}${highlight ? " highlight" : ""}${loaded ? " compact" : ""}`}
          role="button"
          tabIndex={0}
          title={tooltip}
          onClick={() => inputRef.current?.click()}
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
              <span className="dropzone-title">{t(accent === "master" ? "loader.dropMaster" : "loader.dropIncoming")}</span>
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
  accent: "master" | "incoming",
  t: Translate,
): React.ReactNode {
  if (state.status === "error") {
    return <span className="error">{t("loader.error", { fileName: state.fileName, message: state.message })}</span>;
  }
  const { dataset, fileName, report, placeLayout, dateFormat, sourceLayout } = state.file;
  const info = [
    t("loader.version", { version: dataset.version }),
    t("loader.encoding", { charset: dataset.charset }),
  ];
  if (dateFormat) {
    info.push(t("loader.dateFormat", { format: dateFormat }));
  }
  if (placeLayout && placeLayout !== "unknown") {
    info.push(t("loader.placeFormat", { format: t(`placeLayout.${placeLayout}`) }));
  }
  if (sourceLayout && sourceLayout !== "unknown") {
    info.push(t("loader.sourceFormat", { format: t(`sourceLayout.${sourceLayout}`) }));
  }
  info.push(
    t("loader.individuals", { count: dataset.individuals.size }),
    t("loader.families", { count: dataset.families.size }),
  );

  const warnings = dataset.warnings;
  const hasWarnings = warnings.length > 0;
  const warningTooltip = hasWarnings
    ? warnings.map((w) => (w.line != null ? `[${w.line}] ${w.message}` : w.message)).join("\n")
    : undefined;

  const examplesTooltip = (changes: { before: string; after: string }[]): string | undefined =>
    changes.length > 0 ? changes.map((ex) => `${ex.before} → ${ex.after}`).join("\n") : undefined;

  const kv = info.map((s): [string, string] => {
    const i = s.indexOf(":");
    return i >= 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s, ""];
  });

  return (
    <>
      <div className={`gm-file ${accent} loader-filename`}>{fileName}</div>
      <div className="loader-cols">
        <div className="loader-info">
          <dl className="loader-meta">
            {kv.map(([label, value]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
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
        {report && (
          <div className="loader-report">
            <div className="loader-report-head">{t("loader.normalized")}</div>
            <dl className="loader-meta">
              {(
                [
                  [t("loader.dates", { count: report.datesChanged }), examplesTooltip(report.dateExamples)],
                  [t("loader.places", { count: report.placesReshaped }), examplesTooltip(report.placeExamples)],
                  [t("loader.links", { count: report.linksConverted }), examplesTooltip(report.linkExamples)],
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
