import { useRef, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Translate } from "../locales/i18n";
import type { SlotState } from "../App";

interface Props {
  title: string;
  state: SlotState;
  onLoad: (file: File) => void;
  highlight?: boolean;
  tooltip?: string;
}

export function GedcomLoader({ title, state, onLoad, highlight, tooltip }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLoad(file);

    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <section className="loader">
      <div className="loader-head">
        <h2>{title}</h2>
        {state.status !== "loading" && (
          <>
            <button
              className={`nav-btn${highlight ? " highlight" : ""}`}
              onClick={() => inputRef.current?.click()}
              title={tooltip}
            >
              {t("loader.load")}
            </button>
            <input ref={inputRef} className="file-input" type="file" accept=".ged,.gedcom,text/plain" onChange={onChange} />
          </>
        )}
      </div>
      <div className="summary">{renderSummary(state, t)}</div>
    </section>
  );
}

function renderSummary(state: SlotState, t: Translate): React.ReactNode {
  switch (state.status) {
    case "empty":
      return t("loader.empty");
    case "loading":
      return (
        <div className="parsing-status">
          <span className="spinner" aria-hidden="true" />
          {t("loader.parsing", { fileName: state.fileName })}
        </div>
      );
    case "error":
      return <span className="error">{t("loader.error", { fileName: state.fileName, message: state.message })}</span>;
    case "loaded": {
      const { dataset, fileName, report } = state.file;
      const lines = [
        t("loader.file", { fileName }),
        t("loader.version", { version: dataset.version }),
        t("loader.encoding", { charset: dataset.charset }),
        t("loader.individuals", { count: dataset.individuals.size }),
        t("loader.families", { count: dataset.families.size }),
        t("loader.warnings", { count: dataset.warnings.length }),
      ];
      if (report) {
        lines.push(
          "",
          t("loader.normalized"),
          t("loader.datesChanged", { count: report.datesChanged }),
          t("loader.placesChanged", { count: report.placesChanged }),
        );
        for (const ex of report.dateExamples.slice(0, 3)) {
          lines.push(t("loader.dateEx", { before: ex.before, after: ex.after }));
        }
        for (const ex of report.placeExamples.slice(0, 3)) {
          lines.push(t("loader.placeEx", { before: ex.before, after: ex.after }));
        }
      }
      return lines.join("\n");
    }
  }
}
