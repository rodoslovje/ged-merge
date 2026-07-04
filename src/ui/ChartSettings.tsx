import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GearIcon } from "./icons/GearIcon";
import { useChartSettings, type ChartAlignment, type ChartSettings as Settings, type PedigreeType, type TimelineEventScope } from "./ChartSettingsContext";

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

/** Whose bars carry event dots on the Timeline (the timeline-only group). */
const EVENT_SCOPES: TimelineEventScope[] = ["person", "all", "off"];

/** `lockedType` pins the effective diagram type (used by the Relationship
 *  chart, which always lays out as a tree, and by the Timeline and the
 *  Ahnentafel report) so the right option rows show even when the shared
 *  (persisted) type is something else. */
export function ChartSettings({ lockedType }: { lockedType?: PedigreeType | "timeline" | "report" } = {}) {
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
          {/* Per-person fields — each independent (multi-select). The report
              always prints its facts, so only the privacy group applies there. */}
          {effectiveType !== "report" && (<>
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
              connector (tree / grid), the fan collar, or beside the timeline's
              ⚭ markers; both default off. */}
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
          </>)}
          {/* Timeline-only: whose bars carry event dots, the under-bar event
              labels, and the residence strip. */}
          {effectiveType === "timeline" && (
            <div className="chart-settings-group">
              <span className="chart-settings-heading">{t("tree.settings.timeline.events")}</span>
              <div className="chart-settings-segmented">
                {EVENT_SCOPES.map((scope) => (
                  <button
                    key={scope}
                    className={settings.timelineEvents === scope ? "active" : ""}
                    onClick={() => set({ timelineEvents: scope })}
                  >
                    {t(`tree.settings.timeline.events.${scope}`)}
                  </button>
                ))}
              </div>
              <div className="chart-settings-segmented chart-settings-toggles">
                <button
                  className={settings.timelineEventLabels ? "active" : ""}
                  aria-pressed={settings.timelineEventLabels}
                  onClick={() => set({ timelineEventLabels: !settings.timelineEventLabels })}
                >
                  {t("tree.settings.timeline.labels")}
                </button>
                <button
                  className={settings.showResidence ? "active" : ""}
                  aria-pressed={settings.showResidence}
                  onClick={() => set({ showResidence: !settings.showResidence })}
                >
                  {t("tree.settings.timeline.residence")}
                </button>
              </div>
            </div>
          )}
          {/* Report-only: the optional fact lines. Residence is the same shared
              choice the Timeline's strip uses — one semantic, per-view drawing. */}
          {effectiveType === "report" && (
            <div className="chart-settings-group">
              <span className="chart-settings-heading">{t("tree.settings.report.facts")}</span>
              <div className="chart-settings-segmented chart-settings-toggles">
                <button
                  className={settings.showOccupation ? "active" : ""}
                  aria-pressed={settings.showOccupation}
                  onClick={() => set({ showOccupation: !settings.showOccupation })}
                >
                  {t("tree.settings.report.occupation")}
                </button>
                <button
                  className={settings.showEducation ? "active" : ""}
                  aria-pressed={settings.showEducation}
                  onClick={() => set({ showEducation: !settings.showEducation })}
                >
                  {t("tree.settings.report.education")}
                </button>
                <button
                  className={settings.showResidence ? "active" : ""}
                  aria-pressed={settings.showResidence}
                  onClick={() => set({ showResidence: !settings.showResidence })}
                >
                  {t("tree.settings.report.residence")}
                </button>
                <button
                  className={settings.showNotes ? "active" : ""}
                  aria-pressed={settings.showNotes}
                  onClick={() => set({ showNotes: !settings.showNotes })}
                >
                  {t("tree.settings.report.notes")}
                </button>
                <button
                  className={settings.showSources ? "active" : ""}
                  aria-pressed={settings.showSources}
                  onClick={() => set({ showSources: !settings.showSources })}
                >
                  {t("tree.settings.report.sources")}
                </button>
              </div>
            </div>
          )}
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
