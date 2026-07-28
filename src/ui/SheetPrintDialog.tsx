import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import {
  ORIENTATIONS,
  PAPER_SIZES,
  PRINT_SIZES,
  type Orientation,
  type PaperSize,
  type PrintSize,
} from "../chart/sheets";
import { planSheets, printChartSheets, type SheetChartSource } from "./sheetExport";
import type { SvgExportOptions } from "./exportSvg";

// "Print in sheets" — pick the paper, see how many sheets the diagram will take,
// and send the set to the print dialog. A wide family chart squeezed onto one
// page is unreadable; cut into sheets it prints at full size, each branch that
// didn't fit carrying on under its own numbered marker.

interface Props {
  /** The chart to split, exactly as it is drawn on screen. */
  source: SheetChartSource;
  /** The `.tree-canvas` element the rendered diagram is lifted from. */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  /** Header title and download base name, shared with the other exports; each
   *  sheet's second header line is added per sheet. */
  opts: Omit<SvgExportOptions, "subtitle">;
  onClose: () => void;
}

export function SheetPrintDialog({ source, canvasRef, opts, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(true, onClose);
  const [paper, setPaper] = useState<PaperSize>("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [size, setSize] = useState<PrintSize>("medium");

  // The full plan, not just its length: it is what the print then draws, and
  // planning a chart of any ordinary size is quick enough to redo per change.
  const sheets = useMemo(
    () => planSheets(source, { paper, orientation, size }),
    [source, paper, orientation, size],
  );

  const print = () => {
    onClose();
    void printChartSheets(canvasRef.current, source, { paper, orientation, size }, {
      ...opts,
      subtitle: (sheet, total) => {
        const of = t("sheets.sheetOf", { n: sheet.number, total });
        return sheet.from
          ? `${of} · ${t("sheets.continues", { name: sheet.from.name, sheet: sheet.from.sheet })}`
          : of;
      },
    });
  };

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
        <p className="confirm-dialog-body">{t("sheets.intro")}</p>

        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.paper")}</span>
          <div className="chart-settings-segmented">
            {PAPER_SIZES.map((p) => (
              <button
                key={p}
                className={paper === p ? "active" : ""}
                onClick={() => setPaper(p)}
              >
                {t(`sheets.paper.${p}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.orientation")}</span>
          <div className="chart-settings-segmented">
            {ORIENTATIONS.map((o) => (
              <button
                key={o}
                className={orientation === o ? "active" : ""}
                onClick={() => setOrientation(o)}
              >
                {t(`sheets.orientation.${o}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.size")}</span>
          <div className="chart-settings-segmented">
            {PRINT_SIZES.map((s) => (
              <button
                key={s}
                className={size === s ? "active" : ""}
                onClick={() => setSize(s)}
                title={t(`sheets.size.${s}.tip`)}
              >
                {t(`sheets.size.${s}`)}
              </button>
            ))}
          </div>
        </div>

        <p className="sheet-dialog-count" aria-live="polite">
          {t("sheets.count", { count: sheets.length })}
        </p>

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button type="button" className="confirm-dialog-confirm" onClick={print}>
            {t("sheets.print")}
          </button>
        </div>
      </div>
    </div>
  );
}
