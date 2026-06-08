import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
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
}

export function GedcomLoader({ title, state, onLoad, accent, highlight, tooltip }: Props) {
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
          <input ref={inputRef} className="file-input" type="file" accept=".ged,.gedcom,text/plain" onChange={onChange} />
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
  const { dataset, fileName, report, placeLayout } = state.file;
  const info = [
    t("loader.version", { version: dataset.version }),
    t("loader.encoding", { charset: dataset.charset }),
    t("loader.individuals", { count: dataset.individuals.size }),
    t("loader.families", { count: dataset.families.size }),
  ];
  if (placeLayout && placeLayout !== "unknown") {
    info.push(t("loader.placeFormat", { format: t(`placeLayout.${placeLayout}`) }));
  }

  const warnings = dataset.warnings;
  const hasWarnings = warnings.length > 0;
  const warningTooltip = hasWarnings
    ? warnings.map((w) => (w.line != null ? `[${w.line}] ${w.message}` : w.message)).join("\n")
    : undefined;

  const examplesTooltip = (changes: { before: string; after: string }[]): string | undefined =>
    changes.length > 0 ? changes.map((ex) => `${ex.before} → ${ex.after}`).join("\n") : undefined;

  return (
    <>
      <div className={`gm-file ${accent} loader-filename`}>{fileName}</div>
      <div className="loader-cols">
        <div className="loader-info">
          {info.join("\n")}
          {"\n"}
          <span className={hasWarnings ? "loader-warnings alert" : "loader-warnings"} title={warningTooltip}>
            {t("loader.warnings", { count: warnings.length })}
          </span>
        </div>
        {report && (
          <div className="loader-report">
            <div className="loader-report-head">{t("loader.normalized")}</div>
            <span className="loader-report-line" title={examplesTooltip(report.dateExamples)}>
              {t("loader.datesChanged", { count: report.datesChanged })}
            </span>
            {"\n"}
            <span className="loader-report-line" title={examplesTooltip(report.placeExamples)}>
              {t("loader.placesChanged", { count: report.placesChanged })}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
