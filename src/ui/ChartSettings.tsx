import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GearIcon } from "./icons/GearIcon";
import { useChartSettings, type ChartAlignment, type ChartSettings as Settings, type ChartType } from "./ChartSettingsContext";

// The Chart-settings control for the full-page diagram toolbars: a gear button
// that opens a small popover for the Tree alignment (left→right / top→bottom)
// and the per-person / marriage / privacy display toggles. The diagram kind
// itself lives in the ChartKindTabs switcher on the page, not in here. The
// settings are shared + persisted by ChartSettingsContext, so this is pure UI.

const ALIGNMENTS: ChartAlignment[] = ["lr", "tb"];

/** The boolean display toggles, in popover order. */
/** Per-person fields (the "Person" group). */
const DISPLAY_FIELDS: { key: "showLifespan" | "showPhoto" | "showKinship" | "showPlace"; label: string }[] = [
  { key: "showLifespan", label: "lifespan" },
  { key: "showPlace", label: "place" },
  { key: "showPhoto", label: "photo" },
  { key: "showKinship", label: "kinship" },
];

/** Per-couple marriage fields (the "Marriage" group — both default off). */
const MARRIAGE_FIELDS: { key: "showMarriageDate" | "showMarriagePlace"; label: string }[] = [
  { key: "showMarriageDate", label: "date" },
  { key: "showMarriagePlace", label: "place" },
];

/** `lockedType` pins the effective diagram type (used by the Relationship
 *  chart, which always lays out as a tree) so the right option rows show even
 *  when the shared (persisted) type is something else. */
export function ChartSettings({ lockedType }: { lockedType?: ChartType } = {}) {
  const { t } = useTranslation();
  const { settings, setAlignment, set } = useChartSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The effective type drives which extra rows show; with a locked type it wins
  // even if the shared (persisted) type is something else.
  const effectiveType = lockedType ?? settings.type;

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="chart-settings" ref={ref}>
      <button
        className={`tree-open-btn chart-settings-btn${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={t("tree.settings.tooltip")}
        aria-label={t("tree.settings.button")}
        aria-expanded={open}
      >
        <GearIcon /> <span className="chart-settings-label">{t("tree.settings.button")}</span>
      </button>
      {open && (
        <div className="chart-settings-popover" role="dialog" aria-label={t("tree.settings.button")}>
          {/* Alignment only applies to the layered tree; radial charts ignore it. */}
          {effectiveType === "tree" && (
            <div className="chart-settings-group">
              <span className="chart-settings-heading">{t("tree.settings.alignment")}</span>
              <div className="chart-settings-segmented">
                {ALIGNMENTS.map((a) => (
                  <button
                    key={a}
                    className={settings.alignment === a ? "active" : ""}
                    onClick={() => setAlignment(a)}
                  >
                    {t(`tree.settings.alignment.${a}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Per-person fields — each independent (multi-select). */}
          <div className="chart-settings-group">
            <span className="chart-settings-heading">{t("tree.settings.person")}</span>
            <div className="chart-settings-segmented chart-settings-toggles">
              {DISPLAY_FIELDS.map(({ key, label }) => {
                // The radial fan / circle charts don't draw a kinship line.
                const disabled = key === "showKinship" && (effectiveType === "fan" || effectiveType === "circle");
                return (
                  <button
                    key={key}
                    className={settings[key] && !disabled ? "active" : ""}
                    aria-pressed={settings[key] && !disabled}
                    disabled={disabled}
                    title={disabled ? t("tree.settings.notForRadial") : undefined}
                    onClick={() => set({ [key]: !settings[key] } as Partial<Settings>)}
                  >
                    {t(`tree.settings.display.${label}`)}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Per-couple marriage fields (date / place) — drawn on the couple's
              connector (tree / grid) or the fan collar; both default off. */}
          <div className="chart-settings-group">
            <span className="chart-settings-heading">{t("tree.settings.marriage")}</span>
            <div className="chart-settings-segmented chart-settings-toggles">
              {MARRIAGE_FIELDS.map(({ key, label }) => (
                <button
                  key={key}
                  className={settings[key] ? "active" : ""}
                  aria-pressed={settings[key]}
                  onClick={() => set({ [key]: !settings[key] } as Partial<Settings>)}
                >
                  {t(`tree.settings.marriage.${label}`)}
                </button>
              ))}
            </div>
          </div>
          {/* Privacy: redact people inferred to be living. */}
          <div className="chart-settings-group">
            <span className="chart-settings-heading">{t("tree.settings.privacy")}</span>
            <div className="chart-settings-segmented chart-settings-toggles">
              <button
                className={settings.privacyLiving ? "active" : ""}
                aria-pressed={settings.privacyLiving}
                onClick={() => set({ privacyLiving: !settings.privacyLiving })}
              >
                {t("tree.settings.privacy.hideLiving")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
