import { useTranslation } from "react-i18next";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  paperMm,
  type Orientation,
  type PaperName,
  type PaperSize,
} from "../chart/sheets";

// The paper rows of a print dialog — the named papers, and a size typed in
// millimetres — shared by everything that prints on real paper.

/** A picked paper. The typed size is kept as typed, so a half-entered "1"
 *  doesn't get repaired under the cursor. */
export interface PaperChoice {
  name: PaperName | "custom";
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
  if (choice.name !== "custom") return choice.name;
  const [w, h] = [mmValue(choice.w), mmValue(choice.h)];
  return mmInRange(w) && mmInRange(h) ? { wMm: w, hMm: h } : null;
}

/** A choice read back from storage, made safe: a paper this dialog doesn't
 *  offer falls back to `fallback`. */
export function validPaperChoice(choice: PaperChoice, papers: PaperName[], fallback: PaperName): PaperChoice {
  const ok = choice.name === "custom" || papers.includes(choice.name);
  return { name: ok ? choice.name : fallback, w: String(choice.w ?? ""), h: String(choice.h ?? "") };
}

interface Props {
  papers: PaperName[];
  value: PaperChoice;
  /** Which way round a named paper goes — what the custom fields open on. */
  orientation: Orientation;
  onChange: (value: PaperChoice) => void;
}

export function PaperPicker({ papers, value, orientation, onChange }: Props) {
  const { t } = useTranslation();
  // Opening the fields on the paper currently chosen: the user adjusts a real
  // size rather than facing two empty boxes.
  const chooseCustom = () => {
    if (value.name === "custom") return;
    const mm = paperMm(value.name, orientation);
    onChange({ name: "custom", w: String(Math.round(mm.w)), h: String(Math.round(mm.h)) });
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
        </div>
      </div>

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
