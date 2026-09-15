import { useEffect, useRef } from "react";
import { keyHint } from "../keyboard/shortcuts";
import { tabIndexFor, tablistKeyDown } from "../keyboard/tablist";
import { useTranslation } from "react-i18next";
import { useChartSettings, type ChartKind, type FanShape, type TreeLayout } from "./ChartSettingsContext";
import { PickerMenu } from "./PickerMenu";
import { Segmented } from "./Segmented";
import { usePhone } from "./usePhone";

// The chart-kind switcher shown on the full-page diagram views: a first-class
// segmented control (Tree / Fan / Timeline / Relationship / …) so every
// visualization is one click away instead of hiding inside the Chart-settings
// popover. The Charts hub shows all kinds; the Compare Tree passes only the
// pedigree kinds (a relationship diagram has no meaning for a main/incoming
// pair). Each pedigree kind has two looks — the tree is tidy or a grid, the
// fan a fan or a full circle — chosen on the page by PedigreeVariantTabs.

/** Pedigree chart kinds, in display order. */
export const PEDIGREE_KINDS: ChartKind[] = ["tree", "fan"];

const TREE_LAYOUTS: TreeLayout[] = ["tidy", "grid"];
const FAN_SHAPES: FanShape[] = ["fan", "circle"];

/** The pedigree kind's second row: Tree | Grid for the layered chart, Fan |
 *  Circle for the radial one — the chart's look, next to its kind. The radial
 *  bowtie is always a full circle, so its page hides the shape row. */
export function PedigreeVariantTabs({ hideShape = false }: { hideShape?: boolean } = {}) {
  const { t } = useTranslation();
  const { settings, set } = useChartSettings();
  if (settings.type === "fan" && hideShape) return null;
  return settings.type === "fan" ? (
    <Segmented
      label={t("tree.shape")}
      value={settings.fanShape}
      onChange={(fanShape) => set({ fanShape })}
      items={FAN_SHAPES.map((k) => ({ key: k, label: t(`tree.shape.${k}`) }))}
    />
  ) : (
    <Segmented
      label={t("tree.layout")}
      value={settings.treeLayout}
      onChange={(treeLayout) => set({ treeLayout })}
      items={TREE_LAYOUTS.map((k) => ({ key: k, label: t(`tree.layout.${k}`) }))}
    />
  );
}

interface Props {
  kinds: ChartKind[];
  value: ChartKind;
  onChange: (kind: ChartKind) => void;
}

export function ChartKindTabs({ kinds, value, onChange }: Props) {
  const { t } = useTranslation();
  const phone = usePhone();
  // On a phone the row is too narrow for every kind and scrolls sideways, so the
  // selected tab can sit off-screen after a re-entry. Bring it into view.
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  const label = (k: ChartKind) =>
    k === "relationship" ? t("relpath.button")
      : k === "timeline" ? t("timeline.button")
        : k === "kin" ? t("kin.button")
          : k === "map" ? t("map.button")
            : k === "report" ? t("report.button")
              : t(`tree.settings.type.${k}`);
  // Seven kinds never fit across a phone. A dropdown names the one you are on
  // and lists the rest, instead of a sideways scroller that hides most of them.
  if (phone) {
    return (
      <PickerMenu
        className="charts-kind-picker"
        label={t("charts.kind.label")}
        value={value}
        onChange={onChange}
        items={kinds.map((k) => ({ key: k, label: label(k) }))}
      />
    );
  }
  return (
    <div className="tree-mode charts-kind" role="tablist" aria-label={t("charts.kind.label")} onKeyDown={tablistKeyDown}>
      {kinds.map((k, i) => (
        <button
          key={k}
          ref={value === k ? activeRef : undefined}
          role="tab"
          aria-selected={value === k}
          tabIndex={tabIndexFor(value === k)}
          className={value === k ? "active" : ""}
          title={keyHint(label(k), String(i + 1))}
          onClick={() => { if (value !== k) onChange(k); }}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}
