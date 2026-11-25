import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import type { TreeNode } from "../chart/personTree";
import { PaperPicker, chosenPaper, chosenRoll, validPaperChoice, type PaperChoice } from "./PaperPicker";
import { loadPrintPrefs, savePrintPrefs } from "./printPrefs";
import { useChartSettings } from "./ChartSettingsContext";
import { hiddenName, useLivingNameOf } from "./useLivingName";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  NAME_PT,
  ORIENTATIONS,
  PAPER_NAMES,
  PRINT_PCT_MAX,
  PRINT_PCT_MIN,
  PRINT_SCALE,
  PRINT_SIZES,
  TINY_SCALE,
  isPrintSize,
  printScale,
  rollPapers,
  type Orientation,
  type PaperName,
  type PrintSize,
} from "../chart/sheets";
import {
  bestPlan,
  planPrint,
  printCompleteSheets,
  printChartSheets,
  type SheetChartSource,
  type SheetPaper,
} from "./sheetExport";
import { canvasDiagramSize, printCanvasPdf, type SvgExportOptions } from "./exportSvg";

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
/** A preset's scale as the whole percent the field shows. */
const presetPct = (s: Exclude<PrintSize, "fit" | number>) => Math.round(PRINT_SCALE[s] * 100);

export function SheetPrintDialog({ source, canvasRef, opts, onClose }: Props) {
  const { t, i18n } = useTranslation();
  // A person the privacy setting hides is named in a caption as in their box.
  const { settings } = useChartSettings();
  const livingNameOf = useLivingNameOf();
  const figure = (n: number, digits: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: digits }).format(n);
  const hidden = (n: TreeNode) => hiddenName(t, settings.privacyLiving, livingNameOf, n.main ?? n.incoming, n.living, n.sex);
  // Opens on what the last print went out with: the printer rarely changes.
  const [saved] = useState(() => loadPrintPrefs(PREFS_SLOT, DEFAULTS));
  const [choice, setChoice] = useState(() => validPaperChoice(saved, PAPER_NAMES, DEFAULT_PAPER, !!source));
  const [orientation, setOrientation] = useState<Orientation>(ORIENTATIONS.includes(saved.orientation) ? saved.orientation : DEFAULTS.orientation);
  const savedSize = isPrintSize(saved.size) ? saved.size : DEFAULTS.size;
  // The print size is "one sheet" or a scale; the scale is kept as typed, so a
  // half-entered "7" isn't repaired under the cursor. The presets only fill it in.
  const [fit, setFit] = useState(savedSize === "fit");
  const [pct, setPct] = useState(() => String(Math.round((printScale(savedSize) ?? PRINT_SCALE.medium) * 100)));
  const pctValue = Number(pct.trim().replace(",", "."));
  const pctValid = Number.isFinite(pctValue) && pctValue >= PRINT_PCT_MIN && pctValue <= PRINT_PCT_MAX;
  // `null` while the typed scale is unusable, as the paper is below.
  const size: PrintSize | null = fit ? "fit" : pctValid ? pctValue / 100 : null;
  const custom = choice.name === "custom";
  const roll = choice.name === "roll";

  // The papers the print may go on: the one chosen — or, for a roll, the two
  // ways round it can run, of which the plan below takes the thriftier. Empty
  // while the typed paper or scale is unusable: there is then nothing to plan,
  // and the count line explains itself instead of showing a stale number.
  const typedOk = roll ? chosenRoll(choice) !== null : chosenPaper(choice) !== null;
  const papers = useMemo((): SheetPaper[] => {
    if (size === null) return [];
    const width = chosenRoll(choice);
    if (width !== null) return rollPapers(width).map((paper) => ({ paper, orientation: "portrait", size, roll: true }));
    const paper = chosenPaper(choice);
    return paper ? [{ paper, orientation, size }] : [];
  }, [choice, orientation, size]);

  // The full plan, redone per change: planning a chart of any ordinary size is
  // quick. It counts the header, footer and colour key every sheet carries, and
  // says how far the print is reduced (or enlarged) to sit on the paper — the
  // number that tells a wall chart from an unreadable one. An uncuttable chart
  // is measured off the canvas instead.
  const plan = useMemo(
    () => bestPlan(papers.map((paper) => planPrint(source, paper, opts.legend, source ? undefined : canvasDiagramSize(canvasRef.current)))),
    [papers, source, opts.legend, canvasRef],
  );
  const complete = source?.complete;

  const print = () => {
    if (!plan) return;
    const { paper, packed } = plan;
    savePrintPrefs(PREFS_SLOT, { ...choice, orientation, size });
    onClose();
    if (!source) {
      printCanvasPdf(canvasRef.current, opts, paper);
      return;
    }
    if (packed) {
      void printCompleteSheets(canvasRef.current, packed, source, paper, {
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
    void printChartSheets(canvasRef.current, source, paper, {
      ...opts,
      subtitle: (sheet, total) => t("sheets.sheetOf", { n: sheet.number, total }),
    });
  };
  // Opens on Print, so Enter prints; ⌘/Ctrl+Enter does the same from the
  // custom-size fields.
  const printBtn = useRef<HTMLButtonElement>(null);
  const ref = useModalKeyboard(true, onClose, { onConfirm: plan ? print : undefined, initialFocus: printBtn });

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

        <PaperPicker papers={PAPER_NAMES} value={choice} orientation={orientation} roll={!!source} onChange={setChoice} />

        <div className="sheet-dialog-row">
          <span className="chart-settings-heading">{t("sheets.orientation")}</span>
          <div className="chart-settings-segmented">
            {ORIENTATIONS.map((o) => (
              <button
                key={o}
                className={orientation === o ? "active" : ""}
                // A typed size is width × height as typed — there is no portrait
                // of it to switch to; a roll goes whichever way is thriftier.
                disabled={custom || roll}
                title={custom ? t("sheets.orientation.customTip") : roll ? t("sheets.orientation.rollTip") : undefined}
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
                  className={(s === "fit" ? fit : !fit && pctValid && pctValue === presetPct(s)) ? "active" : ""}
                  onClick={() => {
                    setFit(s === "fit");
                    if (s !== "fit") setPct(String(presetPct(s)));
                  }}
                  title={t(`sheets.size.${s}.tip`)}
                >
                  {t(`sheets.size.${s}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* The scale behind the three sizes, open to any figure in between. */}
        {source && !fit && (
          <div className="sheet-dialog-row">
            <span className="chart-settings-heading">{t("sheets.scaleRow")}</span>
            <div className="sheet-dialog-custom-fields">
              <input
                type="number"
                inputMode="decimal"
                min={PRINT_PCT_MIN}
                max={PRINT_PCT_MAX}
                value={pct}
                aria-label={t("sheets.scale.pct")}
                onChange={(e) => setPct(e.target.value)}
              />
              <span className="sheet-dialog-unit">%</span>
            </div>
          </div>
        )}

        <p className={`sheet-dialog-count${plan ? "" : " is-hint"}`} aria-live="polite">
          {plan
            ? [
                t("sheets.count", { count: plan.count }),
                t("sheets.scale", { pct: Math.round(plan.scale * 100), pt: figure(plan.scale * NAME_PT, 1) }),
                // px → m: 96 px to the inch.
                plan.length !== undefined && t("sheets.roll.length", { m: figure((plan.length * 25.4) / 96 / 1000, 2) }),
                plan.smaller > 0 && t("sheets.smaller", { count: plan.smaller }),
              ].filter(Boolean).join(" · ")
            : !typedOk
              ? t(roll ? "sheets.roll.range" : "sheets.custom.range", { min: CUSTOM_MM_MIN, max: CUSTOM_MM_MAX })
              : t("sheets.scale.range", { min: PRINT_PCT_MIN, max: PRINT_PCT_MAX })}
        </p>
        {plan && plan.scale < TINY_SCALE && (
          <p className="sheet-dialog-warning" role="status">{t("sheets.tiny")}</p>
        )}

        {/* The browser's own print window asks for the paper once more. */}
        <p className="sheet-dialog-hint">{t("sheets.pdfHint")}</p>

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("confirm.cancel")}
          </button>
          <button
            ref={printBtn}
            type="button"
            className="confirm-dialog-confirm"
            disabled={!plan}
            onClick={print}
          >
            {t("sheets.print")}
          </button>
        </div>
      </div>
    </div>
  );
}
