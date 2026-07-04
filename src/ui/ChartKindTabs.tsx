import { useTranslation } from "react-i18next";
import type { ChartKind } from "./ChartSettingsContext";

// The chart-kind switcher shown on the full-page diagram views: a first-class
// segmented control (Tree / Grid / Fan / Circle / Relationship) so every
// visualization is one click away instead of hiding inside the Chart-settings
// popover. The Charts hub shows all kinds; the Compare Tree passes only the
// pedigree kinds (a relationship diagram has no meaning for a master/incoming
// pair). Future kinds (timeline, map, reports) become new entries here.

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
    k === "relationship" ? t("relpath.button") : t(`tree.settings.type.${k}`);
  return (
    <div className="tree-mode charts-kind" role="tablist" aria-label={t("charts.kind.label")}>
      {kinds.map((k) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          className={value === k ? "active" : ""}
          onClick={() => { if (value !== k) onChange(k); }}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}
