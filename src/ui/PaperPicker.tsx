import { useTranslation } from "react-i18next";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  paperMm,
  type Orientation,
  type PaperName,
  type PaperSize,
} from "../chart/sheets";

// The paper rows of a print dialog — the named papers, a size typed in
// millimetres, and (where the print can use one) a roll known by its width
// alone — shared by everything that prints on real paper.

/** A picked paper. The typed size is kept as typed, so a half-entered "1"
 *  doesn't get repaired under the cursor. */
export interface PaperChoice {
  name: PaperName | "custom" | "roll";
  /** The typed width — of the custom size, or of the roll. */
  w: string;
  h: string;
}

/** A typed millimetre figure — comma or point, as the keyboard offers it. */
function mmValue(s: string): number {
  return Number(s.trim().replace(",", "."));
}

function mmInRange(mm: number): boolean {
  return Number.isFinite(mm) && mm >= CUSTOM_MM_MIN && mm <= CUSTOM_MM_MAX;
}

/** The paper a choice stands for; `null` while the typed size is unusable. */
export function chosenPaper(choice: PaperChoice): PaperSize | null {
  if (choice.name === "roll") return null; // a width alone: see chosenRoll
  if (choice.name !== "custom") return choice.name;
  const [w, h] = [mmValue(choice.w), mmValue(choice.h)];
  return mmInRange(w) && mmInRange(h) ? { wMm: w, hMm: h } : null;
}

/** The width of a chosen roll, in mm; `null` for any other paper, and while
 *  the typed width is unusable. */
export function chosenRoll(choice: PaperChoice): number | null {
  const w = mmValue(choice.w);
  return choice.name === "roll" && mmInRange(w) ? w : null;
}

/** A choice read back from storage, made safe: a paper this dialog doesn't
 *  offer falls back to `fallback`. */
export function validPaperChoice(choice: PaperChoice, papers: PaperName[], fallback: PaperName, roll = false): PaperChoice {
  const ok = choice.name === "custom" || (choice.name === "roll" ? roll : papers.includes(choice.name));
  return { name: ok ? choice.name : fallback, w: String(choice.w ?? ""), h: String(choice.h ?? "") };
}

interface Props {
  papers: PaperName[];
  value: PaperChoice;
  /** Which way round a named paper goes — what the custom fields open on. */
  orientation: Orientation;
  /** Offer a roll too — for a print that can run to whatever length it needs. */
  roll?: boolean;
  onChange: (value: PaperChoice) => void;
}

export function PaperPicker({ papers, value, orientation, roll = false, onChange }: Props) {
  const { t } = useTranslation();
  // Opening the fields on the paper currently chosen: the user adjusts a real
  // size rather than facing two empty boxes.
  const chooseCustom = () => {
    if (value.name === "custom") return;
    // From a roll, its width stays and the other side is left to type.
    if (value.name === "roll") return onChange({ ...value, name: "custom" });
    const mm = paperMm(value.name, orientation);
    onChange({ name: "custom", w: String(Math.round(mm.w)), h: String(Math.round(mm.h)) });
  };
  // A roll opens on the short side of the paper it was chosen from.
  const chooseRoll = () => {
    if (value.name === "roll") return;
    const short = value.name === "custom"
      ? Math.min(mmValue(value.w), mmValue(value.h))
      : paperMm(value.name, "portrait").w;
    onChange({ ...value, name: "roll", w: Number.isFinite(short) ? String(Math.round(short)) : "" });
  };
  return (
    <>
      <div className="sheet-dialog-row sheet-dialog-papers">
        <span className="chart-settings-heading">{t("sheets.paper")}</span>
        <div className="chart-settings-segmented">
          {papers.map((p) => (
            <button
              key={p}
              className={value.name === p ? "active" : ""}
              onClick={() => onChange({ ...value, name: p })}
            >
              {t(`sheets.paper.${p}`)}
            </button>
          ))}
          <button
            className={value.name === "custom" ? "active" : ""}
            onClick={chooseCustom}
            title={t("sheets.paper.custom.tip")}
          >
            {t("sheets.paper.custom")}
          </button>
          {roll && (
            <button
              className={value.name === "roll" ? "active" : ""}
              onClick={chooseRoll}
              title={t("sheets.paper.roll.tip")}
            >
              {t("sheets.paper.roll")}
            </button>
          )}
        </div>
      </div>

      {value.name === "roll" && (
        <div className="sheet-dialog-row sheet-dialog-custom">
          <span className="chart-settings-heading">{t("sheets.roll")}</span>
          <div className="sheet-dialog-custom-fields">
            <input
              type="number"
              inputMode="decimal"
              min={CUSTOM_MM_MIN}
              max={CUSTOM_MM_MAX}
              value={value.w}
              aria-label={t("sheets.custom.width")}
              onChange={(e) => onChange({ ...value, w: e.target.value })}
            />
            <span className="sheet-dialog-unit">{t("sheets.custom.mm")}</span>
          </div>
        </div>
      )}

      {value.name === "custom" && (
        <div className="sheet-dialog-row sheet-dialog-custom">
          <span className="chart-settings-heading">{t("sheets.custom")}</span>
          <div className="sheet-dialog-custom-fields">
            <input
              type="number"
              inputMode="decimal"
              min={CUSTOM_MM_MIN}
              max={CUSTOM_MM_MAX}
              value={value.w}
              aria-label={t("sheets.custom.width")}
              onChange={(e) => onChange({ ...value, w: e.target.value })}
            />
            <span aria-hidden="true">×</span>
            <input
              type="number"
              inputMode="decimal"
              min={CUSTOM_MM_MIN}
              max={CUSTOM_MM_MAX}
              value={value.h}
              aria-label={t("sheets.custom.height")}
              onChange={(e) => onChange({ ...value, h: e.target.value })}
            />
            <span className="sheet-dialog-unit">{t("sheets.custom.mm")}</span>
          </div>
        </div>
      )}
    </>
  );
}
