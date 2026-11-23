import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../../keyboard/useModalKeyboard";
import { CUSTOM_MM_MAX, CUSTOM_MM_MIN, type PaperName, type PaperSize } from "../../chart/sheets";
import { PaperPicker, chosenPaper, validPaperChoice, type PaperChoice } from "../PaperPicker";
import { loadPrintPrefs, savePrintPrefs } from "../printPrefs";
import { PRINT_DPI, softPages } from "./photoQuality";
import { DEFAULT_PAPER, formatOrientation, printGeometry, type CalendarFormat } from "./CalendarPage";

// Print the calendar: pick the paper, as a diagram's print does. The format
// settled the pages' shape back in the first step; how large they come out is
// only this choice, so the same calendar goes on A5 at home and A3 at a copy
// shop. Which way round the paper goes follows from the format.

/** The papers a calendar is offered; anything else is typed in. */
const PAPERS: PaperName[] = ["a5", "a4", "a3", "letter"];

interface Props {
  format: CalendarFormat;
  /** The calendar's photos, each with the page it is on and its `photoPxPerPage`. */
  photos: { label: string; px: number }[];
  onPrint: (paper: PaperSize) => void;
  onClose: () => void;
}

export function CalendarPrintDialog({ format, photos, onPrint, onClose }: Props) {
  const { t } = useTranslation();
  // Remembered per format: a desk calendar's paper is not a wall calendar's.
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
    onClose();
    onPrint(paper);
  };
  const printBtn = useRef<HTMLButtonElement>(null);
  const ref = useModalKeyboard(true, onClose, { onConfirm: paper ? print : undefined, initialFocus: printBtn });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="confirm-dialog sheet-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("sheets.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="confirm-dialog-title">{t("sheets.title")}</p>
        <p className="confirm-dialog-body">{t("calendar.print.intro")}</p>

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

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button ref={printBtn} type="button" className="confirm-dialog-confirm" disabled={!paper} onClick={print}>
            {t("sheets.print")}
          </button>
        </div>
      </div>
    </div>
  );
}
