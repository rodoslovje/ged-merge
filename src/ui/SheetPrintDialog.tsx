import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  ORIENTATIONS,
  PAPER_NAMES,
  PRINT_SIZES,
  paperMm,
  type Orientation,
  type PaperName,
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

/** A typed millimetre figure — comma or point, as the keyboard offers it. */
function mmValue(s: string): number {
  return Number(s.trim().replace(",", "."));
}

function mmInRange(mm: number): boolean {
  return Number.isFinite(mm) && mm >= CUSTOM_MM_MIN && mm <= CUSTOM_MM_MAX;
}

export function SheetPrintDialog({ source, canvasRef, opts, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(true, onClose);
  const [choice, setChoice] = useState<PaperName | "custom">("a4");
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [size, setSize] = useState<PrintSize>("medium");
  // Kept as typed, so a half-entered "1" doesn't get repaired under the cursor.
  const [custom, setCustom] = useState({ w: "", h: "" });

  // `null` while the typed size is unusable — the plan then has nothing to work
  // from, and the count line explains itself instead of showing a stale number.
  const paper = useMemo<PaperSize | null>(() => {
    if (choice !== "custom") return choice;
    const [w, h] = [mmValue(custom.w), mmValue(custom.h)];
    return mmInRange(w) && mmInRange(h) ? { wMm: w, hMm: h } : null;
  }, [choice, custom.w, custom.h]);

  // Opening the fields on the paper currently chosen: the user adjusts a real
  // size rather than facing two empty boxes.
  const chooseCustom = () => {
    if (choice === "custom") return;
    const mm = paperMm(choice, orientation);
    setCustom({ w: String(Math.round(mm.w)), h: String(Math.round(mm.h)) });
    setChoice("custom");
  };

  // The full plan, not just its length: it is what the print then draws, and
  // planning a chart of any ordinary size is quick enough to redo per change.
  const sheets = useMemo(
    () => (paper ? planSheets(source, { paper, orientation, size }) : []),
    [source, paper, orientation, size],
  );

  const print = () => {
    if (!paper) return;
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

        <div className="sheet-dialog-row sheet-dialog-papers">
          <span className="chart-settings-heading">{t("sheets.paper")}</span>
          <div className="chart-settings-segmented">
            {PAPER_NAMES.map((p) => (
              <button
                key={p}
                className={choice === p ? "active" : ""}
                onClick={() => setChoice(p)}
              >
                {t(`sheets.paper.${p}`)}
              </button>
            ))}
            <button
              className={choice === "custom" ? "active" : ""}
              onClick={chooseCustom}
              title={t("sheets.paper.custom.tip")}
            >
              {t("sheets.paper.custom")}
            </button>
          </div>
        </div>

        {choice === "custom" && (
          <div className="sheet-dialog-row sheet-dialog-custom">
            <span className="chart-settings-heading">{t("sheets.custom")}</span>
            <div className="sheet-dialog-custom-fields">
              <input
                type="number"
                inputMode="decimal"
                min={CUSTOM_MM_MIN}
                max={CUSTOM_MM_MAX}
                value={custom.w}
                aria-label={t("sheets.custom.width")}
                onChange={(e) => setCustom((c) => ({ ...c, w: e.target.value }))}
              />
              <span aria-hidden="true">×</span>
              <input
                type="number"
                inputMode="decimal"
                min={CUSTOM_MM_MIN}
                max={CUSTOM_MM_MAX}
                value={custom.h}
                aria-label={t("sheets.custom.height")}
                onChange={(e) => setCustom((c) => ({ ...c, h: e.target.value }))}
              />
              <span className="sheet-dialog-unit">{t("sheets.custom.mm")}</span>
            </div>
          </div>
        )}

        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.orientation")}</span>
          <div className="chart-settings-segmented">
            {ORIENTATIONS.map((o) => (
              <button
                key={o}
                className={orientation === o ? "active" : ""}
                // A typed size is width × height as typed — there is no portrait
                // of it to switch to.
                disabled={choice === "custom"}
                title={choice === "custom" ? t("sheets.orientation.customTip") : undefined}
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

        <p className={`sheet-dialog-count${paper ? "" : " is-hint"}`} aria-live="polite">
          {paper
            ? t("sheets.count", { count: sheets.length })
            : t("sheets.custom.range", { min: CUSTOM_MM_MIN, max: CUSTOM_MM_MAX })}
        </p>

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button
            type="button"
            className="confirm-dialog-confirm"
            disabled={!paper}
            onClick={print}
          >
            {t("sheets.print")}
          </button>
        </div>
      </div>
    </div>
  );
}
