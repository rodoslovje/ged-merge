import { useTranslation } from "react-i18next";
import type { ChartKind } from "./ChartSettingsContext";

// The chart-kind switcher shown on the full-page diagram views: a first-class
// segmented control (Tree / Grid / Fan / Circle / Timeline / Relationship) so
// every visualization is one click away instead of hiding inside the
// Chart-settings popover. The Charts hub shows all kinds; the Compare Tree
// passes only the pedigree kinds (a relationship diagram has no meaning for a
// main/incoming pair). Future kinds (map, reports) become new entries here.

/** Pedigree chart kinds, in display order. */
export const PEDIGREE_KINDS: ChartKind[] = ["tree", "grid", "fan", "circle"];

interface Props {
  kinds: ChartKind[];
  value: ChartKind;
  onChange: (kind: ChartKind) => void;
}

export function ChartKindTabs({ kinds, value, onChange }: Props) {
  const { t } = useTranslation();
  const label = (k: ChartKind) =>
    k === "relationship" ? t("relpath.button")
      : k === "timeline" ? t("timeline.button")
        : k === "map" ? t("map.button")
          : k === "report" ? t("report.button")
            : t(`tree.settings.type.${k}`);
  return (
    <div className="tree-mode charts-kind" role="tablist" aria-label={t("charts.kind.label")}>
      {kinds.map((k) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          className={value === k ? "active" : ""}
          title={k === "fan" || k === "circle" ? t("charts.kind.ancestorsOnly") : undefined}
          onClick={() => { if (value !== k) onChange(k); }}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}
