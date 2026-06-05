import type { ChangeEvent } from "react";
import type { SlotState } from "../App";

interface Props {
  title: string;
  state: SlotState;
  onLoad: (file: File) => void;
}

export function GedcomLoader({ title, state, onLoad }: Props) {
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLoad(file);
  }

  return (
    <section className="loader">
      <h2>{title}</h2>
      <input type="file" accept=".ged,.gedcom,text/plain" onChange={onChange} />
      <div className="summary">{renderSummary(state)}</div>
    </section>
  );
}

function renderSummary(state: SlotState): React.ReactNode {
  switch (state.status) {
    case "empty":
      return "No file loaded.";
    case "loading":
      return `Parsing ${state.fileName}…`;
    case "error":
      return <span className="error">Error in {state.fileName}: {state.message}</span>;
    case "loaded": {
      const { dataset, fileName, report } = state.file;
      const lines = [
        `File: ${fileName}`,
        `GEDCOM version: ${dataset.version}`,
        `Encoding: ${dataset.charset}`,
        `Individuals: ${dataset.individuals.size}`,
        `Families: ${dataset.families.size}`,
        `Warnings: ${dataset.warnings.length}`,
      ];
      if (report) {
        lines.push(
          "",
          "Normalized to master:",
          `  Dates changed: ${report.datesChanged}`,
          `  Places changed: ${report.placesChanged}`,
        );
        for (const ex of report.dateExamples.slice(0, 3)) {
          lines.push(`  date: ${ex.before} → ${ex.after}`);
        }
        for (const ex of report.placeExamples.slice(0, 3)) {
          lines.push(`  place: ${ex.before} → ${ex.after}`);
        }
      }
      return lines.join("\n");
    }
  }
}
