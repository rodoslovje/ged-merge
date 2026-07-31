import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ChartKind } from "./ChartSettingsContext";
import { PickerMenu } from "./PickerMenu";
import { usePhone } from "./usePhone";

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
        : k === "map" ? t("map.button")
          : k === "report" ? t("report.button")
            : t(`tree.settings.type.${k}`);
  const hint = (k: ChartKind) => (k === "fan" || k === "circle" ? t("charts.kind.ancestorsOnly") : undefined);
  // Eight kinds never fit across a phone. A dropdown names the one you are on
  // and lists the rest, instead of a sideways scroller that hides most of them.
  if (phone) {
    return (
      <PickerMenu
        className="charts-kind-picker"
        label={t("charts.kind.label")}
        value={value}
        onChange={onChange}
        items={kinds.map((k) => ({ key: k, label: label(k), title: hint(k) }))}
      />
    );
  }
  return (
    <div className="tree-mode charts-kind" role="tablist" aria-label={t("charts.kind.label")}>
      {kinds.map((k) => (
        <button
          key={k}
          ref={value === k ? activeRef : undefined}
          role="tab"
          aria-selected={value === k}
          className={value === k ? "active" : ""}
          title={hint(k)}
          onClick={() => { if (value !== k) onChange(k); }}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}
