import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GearIcon } from "./icons/GearIcon";
import { useChartSettings, type ChartAlignment, type ChartSettings as Settings, type ChartType } from "./ChartSettingsContext";

// The Chart-settings control for the full-page diagram toolbars: a gear button
// that opens a small popover for the diagram Type (only "tree" enabled for now)
// and the Tree alignment (left→right / top→bottom). The settings themselves are
// shared + persisted by ChartSettingsContext, so this is pure UI.

/** Diagram types in button order. Fan/Circle are radial ancestor charts. */
const TYPES: { key: ChartType; enabled: boolean }[] = [
  { key: "tree", enabled: true },
  { key: "grid", enabled: true },
  { key: "fan", enabled: true },
  { key: "circle", enabled: true },
];

const ALIGNMENTS: ChartAlignment[] = ["lr", "tb"];

/** The boolean display toggles, in popover order. */
const DISPLAY_FIELDS: { key: "showLifespan" | "showPhoto" | "showKinship" | "showPlace"; label: string }[] = [
  { key: "showLifespan", label: "lifespan" },
  { key: "showPlace", label: "place" },
  { key: "showPhoto", label: "photo" },
  { key: "showKinship", label: "kinship" },
];

export function ChartSettings() {
  const { t } = useTranslation();
  const { settings, setType, setAlignment, set } = useChartSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
          <div className="chart-settings-group">
            <span className="chart-settings-heading">{t("tree.settings.type")}</span>
            <div className="chart-settings-segmented">
              {TYPES.map(({ key, enabled }) => (
                <button
                  key={key}
                  className={settings.type === key ? "active" : ""}
                  disabled={!enabled}
                  title={enabled ? undefined : t("tree.settings.comingSoon")}
                  onClick={() => setType(key)}
                >
                  {t(`tree.settings.type.${key}`)}
                </button>
              ))}
            </div>
          </div>
          {/* Alignment only applies to the layered tree; radial charts ignore it. */}
          {settings.type === "tree" && (
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
          {/* Per-field show/hide toggles — each independent (multi-select). */}
          <div className="chart-settings-group">
            <span className="chart-settings-heading">{t("tree.settings.display")}</span>
            <div className="chart-settings-segmented chart-settings-toggles">
              {DISPLAY_FIELDS.map(({ key, label }) => {
                // The radial fan / circle charts don't draw a kinship line.
                const disabled = key === "showKinship" && (settings.type === "fan" || settings.type === "circle");
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
