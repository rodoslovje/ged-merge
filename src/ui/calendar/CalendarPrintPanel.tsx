import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CUSTOM_MM_MAX, CUSTOM_MM_MIN, type PaperName, type PaperSize } from "../../chart/sheets";
import { PaperPicker, chosenPaper, validPaperChoice, type PaperChoice } from "../PaperPicker";
import { loadPrintPrefs, savePrintPrefs } from "../printPrefs";
import { PrinterIcon } from "../icons/FormatIcons";
import { PRINT_DPI, softPages } from "./photoQuality";
import { DEFAULT_PAPER, formatOrientation, printGeometry, type CalendarFormat } from "./CalendarPage";

// The review step's print controls: the paper, what the pages come out at on
// it, and the Print button. The format settled the pages' shape back in the
// first step; how large they come out is only this choice, so the same
// calendar goes on A5 at home and A3 at a copy shop. Which way round the paper
// goes follows from the format. It sits in the panel rather than in a dialog,
// so everything to settle before printing is read in one place.

/** The papers a calendar is offered; anything else is typed in. */
const PAPERS: PaperName[] = ["a5", "a4", "a3", "letter"];

interface Props {
  /** Mount it keyed by the format: the paper is remembered per format. */
  format: CalendarFormat;
  /** The calendar's photos, each with the page it is on and its `photoPxPerPage`. */
  photos: { label: string; px: number }[];
  printing: boolean;
  onPrint: (paper: PaperSize) => void;
}

export function CalendarPrintPanel({ format, photos, printing, onPrint }: Props) {
  const { t } = useTranslation();
  // A desk calendar's paper is not a wall calendar's.
  const slot = `calendar.${format}`;
  const [choice, setChoice] = useState(() => {
    const fallback: PaperChoice = { name: DEFAULT_PAPER[format], w: "", h: "" };
    return validPaperChoice(loadPrintPrefs(slot, fallback), PAPERS, DEFAULT_PAPER[format]);
  });
  const paper = useMemo(() => chosenPaper(choice), [choice]);
  const geometry = paper ? printGeometry(format, paper) : null;
  // Photos print as the files they are; the larger the paper, the thinner
  // their pixels are spread.
  const soft = geometry ? softPages(photos, geometry.page.w) : [];

  const print = () => {
    if (!paper) return;
    savePrintPrefs(slot, choice);
    onPrint(paper);
  };

  return (
    <div className="cal-print-panel">
      <PaperPicker papers={PAPERS} value={choice} orientation={formatOrientation(format)} onChange={setChoice} />

      <p className={`sheet-dialog-count${geometry ? "" : " is-hint"}`} aria-live="polite">
        {geometry
          ? `${Math.round(geometry.sheet.w)} × ${Math.round(geometry.sheet.h)} ${t("sheets.custom.mm")} · ${t("sheets.scale", { pct: Math.round(geometry.scale * 100) })}`
          : t("sheets.custom.range", { min: CUSTOM_MM_MIN, max: CUSTOM_MM_MAX })}
      </p>

      {soft.length > 0 && (
        <p className="sheet-dialog-warning" role="status">
          {t("calendar.print.soft", {
            dpi: PRINT_DPI,
            list: soft.map((p) => t("calendar.print.soft.page", p)).join(", "),
          })}
        </p>
      )}

      <button type="button" className="nav-btn primary cal-print-btn" disabled={printing || !paper} aria-busy={printing} onClick={print}>
        {printing ? <span className="spinner" aria-hidden="true" /> : <PrinterIcon />} {t("calendar.print")}
      </button>
    </div>
  );
}
