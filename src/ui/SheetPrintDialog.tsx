import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import type { TreeNode } from "../chart/personTree";
import { PaperPicker, chosenPaper, validPaperChoice, type PaperChoice } from "./PaperPicker";
import { loadPrintPrefs, savePrintPrefs } from "./printPrefs";
import { useChartSettings } from "./ChartSettingsContext";
import { hiddenName, useLivingNameOf } from "./useLivingName";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  ORIENTATIONS,
  PAPER_NAMES,
  PRINT_SIZES,
  type Orientation,
  type PaperName,
  type PrintSize,
} from "../chart/sheets";
import {
  fillScale,
  pageBox,
} from "../chart/sheets";
import {
  completePrintScales,
  packedTrees,
  planCompleteSheets,
  planPrintScale,
  planSheets,
  printCompleteSheets,
  printChartSheets,
  sheetBandsHeight,
  type SheetChartSource,
} from "./sheetExport";
import {
  FOOTER_H,
  HEADER_H,
  canvasDiagramSize,
  printCanvasPdf,
  type SvgExportOptions,
} from "./exportSvg";

// Print a chart: pick the paper, see what it will come out at, and send it to
// the print dialog. Every chart goes through here, because the paper is the one
// thing the app can't guess — asking a printer for a page the size of the
// diagram gets you whatever the driver falls back to, with the chart cropped.
//
// Layered charts (tidy tree, grid) can also be *cut*: too big for one page,
// they split at their branches, each cut branch carrying on in a frame of its
// own under a numbered marker, the frames packed onto as few sheets as hold them. That is what the print-size row offers; a chart with
// no `source` to split simply prints whole on the one sheet.

interface Props {
  /** The chart as a tree, when it is one that can be cut into sheets. Radial,
   *  timeline and relationship diagrams leave it out and print on one sheet. */
  source?: SheetChartSource;
  /** The `.tree-canvas` element the rendered diagram is lifted from. */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  /** Header title and download base name, shared with the other exports; each
   *  sheet's second header line is added per sheet. */
  opts: Omit<SvgExportOptions, "subtitle">;
  onClose: () => void;
}

/** What the dialog opens on, until a print has been made from this browser. */
const DEFAULT_PAPER: PaperName = "a4";
const DEFAULTS: PaperChoice & { orientation: Orientation; size: PrintSize } = {
  name: DEFAULT_PAPER, w: "", h: "", orientation: "landscape", size: "medium",
};
const PREFS_SLOT = "chart";

export function SheetPrintDialog({ source, canvasRef, opts, onClose }: Props) {
  const { t } = useTranslation();
  // A person the privacy setting hides is named in a caption as in their box.
  const { settings } = useChartSettings();
  const livingNameOf = useLivingNameOf();
  const hidden = (n: TreeNode) => hiddenName(t, settings.privacyLiving, livingNameOf, n.main ?? n.incoming, n.living, n.sex);
  // Opens on what the last print went out with: the printer rarely changes.
  const [saved] = useState(() => loadPrintPrefs(PREFS_SLOT, DEFAULTS));
  const [choice, setChoice] = useState(() => validPaperChoice(saved, PAPER_NAMES, DEFAULT_PAPER));
  const [orientation, setOrientation] = useState<Orientation>(ORIENTATIONS.includes(saved.orientation) ? saved.orientation : DEFAULTS.orientation);
  const [size, setSize] = useState<PrintSize>(PRINT_SIZES.includes(saved.size) ? saved.size : DEFAULTS.size);
  const custom = choice.name === "custom";

  // `null` while the typed size is unusable — the plan then has nothing to work
  // from, and the count line explains itself instead of showing a stale number.
  const paper = useMemo(() => chosenPaper(choice), [choice]);

  // The full plan, not just its length: it is what the print then draws, and
  // planning a chart of any ordinary size is quick enough to redo per change.
  // The header, footer and — when the chart has one — the colour key, which
  // every sheet carries: the plan and the preview must count the same bands the
  // print will draw, or the set comes out smaller than the dialog promised.
  const bandsH = useMemo(
    () => (paper ? sheetBandsHeight(opts.legend, { paper, orientation, size }) : HEADER_H + FOOTER_H),
    [opts.legend, paper, orientation, size],
  );
  const complete = source?.complete;
  const sheets = useMemo(
    () => (source && !complete && paper ? planSheets(source, { paper, orientation, size }, bandsH) : []),
    [source, complete, paper, orientation, size, bandsH],
  );
  // The Complete Tree, and any chart cut into more than one sheet, prints as
  // its pieces packed onto pages instead: several branches share a sheet.
  const packed = useMemo(() => (source ? packedTrees(source, sheets) : undefined), [source, sheets]);
  const pages = useMemo(
    () => (source && packed && paper ? planCompleteSheets(packed, source, { paper, orientation, size }, bandsH) : []),
    [source, packed, paper, orientation, size, bandsH],
  );
  const count = !source ? 1 : packed ? pages.length : sheets.length;
  // Packed pages that print smaller than the rest (see completePrintScales).
  const smaller = pages.filter((p) => p.oversized).length;

  // How much the print will be reduced (or enlarged) to sit on the paper — the
  // number that says whether "one sheet" is a wall chart or an unreadable one.
  // An uncuttable chart is measured off the canvas instead of a plan.
  const scale = useMemo(() => {
    if (!paper) return 1;
    const box = pageBox(paper, orientation);
    if (pages.length) {
      return completePrintScales(pages.map((p) => ({ ...p, height: p.height + bandsH })), { paper, orientation }).common;
    }
    if (source && sheets.length) return planPrintScale(source, { paper, orientation, size }, sheets, bandsH);
    const whole = canvasDiagramSize(canvasRef.current);
    return whole ? fillScale([{ width: whole.w, height: whole.h + bandsH }], box) : 1;
  }, [source, paper, orientation, size, sheets, pages, canvasRef, bandsH]);

  const print = () => {
    if (!paper) return;
    savePrintPrefs(PREFS_SLOT, { ...choice, orientation, size });
    onClose();
    if (!source) {
      printCanvasPdf(canvasRef.current, opts, { paper, orientation });
      return;
    }
    if (packed) {
      void printCompleteSheets(canvasRef.current, packed, source, { paper, orientation, size }, {
        ...opts,
        subtitle: (page, total) => {
          const of = t("sheets.sheetOf", { n: page.number, total });
          return complete ? `${of} · ${t("sheets.trees", { list: page.pieces.map((p) => p.label).join(", ") })}` : of;
        },
        pieceTitle: (piece) => {
          const who = hidden(piece.top) ?? (piece.top.years ? `${piece.top.name} (${piece.top.years})` : piece.top.name);
          return piece.from ? `${who} — ${t(complete ? "sheets.treeFrom" : "sheets.partFrom", { label: piece.from })}` : who;
        },
      });
      return;
    }
    // A chart that fits one sheet: the set is that sheet alone.
    void printChartSheets(canvasRef.current, source, { paper, orientation, size }, {
      ...opts,
      subtitle: (sheet, total) => t("sheets.sheetOf", { n: sheet.number, total }),
    });
  };
  // Opens on Print, so Enter prints; ⌘/Ctrl+Enter does the same from the
  // custom-size fields.
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
        <p className="confirm-dialog-body">{t(source ? "sheets.intro" : "sheets.intro.one")}</p>

        <PaperPicker papers={PAPER_NAMES} value={choice} orientation={orientation} onChange={setChoice} />

        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.orientation")}</span>
          <div className="chart-settings-segmented">
            {ORIENTATIONS.map((o) => (
              <button
                key={o}
                className={orientation === o ? "active" : ""}
                // A typed size is width × height as typed — there is no portrait
                // of it to switch to.
                disabled={custom}
                title={custom ? t("sheets.orientation.customTip") : undefined}
                onClick={() => setOrientation(o)}
              >
                {t(`sheets.orientation.${o}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Only a layered chart can be cut, so only it is asked how far. */}
        {source && (
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
        )}

        <p className={`sheet-dialog-count${paper ? "" : " is-hint"}`} aria-live="polite">
          {paper
            ? `${t("sheets.count", { count })} · ${t("sheets.scale", {
                pct: Math.round(scale * 100),
              })}` + (smaller ? ` · ${t("sheets.smaller", { count: smaller })}` : "")
            : t("sheets.custom.range", { min: CUSTOM_MM_MIN, max: CUSTOM_MM_MAX })}
        </p>

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button
            ref={printBtn}
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
