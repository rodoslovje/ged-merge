import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeoCoord } from "../../gedcom/types";
import { formatCoord } from "../../geo/points";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import type { PlaceGroup } from "./useAddressCoordRows";

/**
 * Give every ticked address of one place the same position.
 *
 * For the houses no register can answer: village numbering that has since been
 * redrawn, a farm that no longer stands, a house named after a family rather
 * than numbered. Their coordinate cannot be the building's, but it can be the
 * hamlet's — near enough to put the family on a map, and far better than
 * nothing, which is what those events have now.
 *
 * The position comes from the Edit view's own coordinate control, so it can be
 * typed, taken off the map, or searched for in OpenStreetMap; the file's own
 * coordinate for the place opens as the offer, since "the centre of the
 * village" is usually exactly that. The picks are staged like every other one
 * on this page — the section's Write button commits the lot as one undo step.
 */
export function BulkCoordPanel({
  group,
  pick,
  selected,
  prefix,
  onPrefix,
  onPick,
  onClear,
  onSelectAll,
  onApply,
  onCancel,
}: {
  group: PlaceGroup;
  pick: { coord: GeoCoord; label: string } | null;
  selected: ReadonlySet<string>;
  /** Ticks every address starting with this text; empty means all of them. */
  prefix: string;
  onPrefix: (value: string) => void;
  onPick: (coord: GeoCoord, label?: string) => void;
  onClear: () => void;
  onSelectAll: (all: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const events = group.rows.filter((r) => selected.has(r.key)).reduce((n, r) => n + r.count, 0);
  const fileCoord = group.rows.find((r) => r.coord)?.coord;
  /** Held here because two controls open the one panel — the pin and the
   *  position beside it — exactly as an address row does it. */
  const [open, setOpen] = useState(false);

  return (
    <div
      className="tools-place-rename tools-geo-addr-move"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.defaultPrevented && pick && selected.size) onApply();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <p className="tools-intro">{t("tools.geocode.addr.bulkIntro")}</p>
      <EventCoordPicker
        place={group.place}
        // The prefix that ticked these rows is also what they are: "Stražišče"
        // under Kranj, "Vas" under a hamlet. Handing it over as the address
        // asks the registers about that place — "Stražišče, Kranj" rather than
        // Kranj alone — which is the position being looked for. Empty prefix,
        // empty address: then the whole place is ticked and its own centre is
        // exactly the answer.
        address={prefix.trim()}
        coord={pick?.coord}
        title={group.place}
        fileCoord={fileCoord}
        open={open}
        onOpenChange={setOpen}
        onPick={onPick}
        onClear={onClear}
      />
      {/* The position picked, beside the pin that picked it — unmarked, since
          that pin is the mark and stands right against this text. It opens the
          panel too: a position on screen is the thing being changed, and every
          address row below is opened by clicking exactly this. */}
      <button
        type="button"
        className={"tools-place-rename-hint tools-geo-coord-btn" + (pick ? " gm-data" : "")}
        title={t("tools.geocode.addr.openHint")}
        onClick={() => setOpen(true)}
      >
        {pick ? formatCoord(pick.coord) : t("tools.geocode.addr.bulkNoCoord")}
      </button>
      {/* Ticking a run of houses by what they start with — "Stražišče 11" for
          both farms of that number, "Vas" for a hamlet whose numbering the
          register lost. The ticks stay visible below, so what a prefix caught
          is read off the list rather than trusted. */}
      <span className="tools-geo-addr-chip" title={t("tools.geocode.addr.bulkPrefixHint")}>
        {t("tools.geocode.addr.bulkPrefixLabel")}:
        <input
          type="text"
          className="tools-geo-addr-chip-input"
          value={prefix}
          size={Math.max(10, prefix.length + 1)}
          placeholder={t("tools.geocode.addr.bulkPrefix")}
          onChange={(e) => onPrefix(e.target.value)}
        />
        {prefix && (
          <button
            className="tools-geo-addr-chip-clear"
            onClick={() => onPrefix("")}
            aria-label={t("tools.places.rename.cancel")}
          >
            ×
          </button>
        )}
      </span>
      <span className="tools-place-rename-hint">
        {t("tools.geocode.addr.moveCount", { count: selected.size, events })}
      </span>
      <button className="tools-issue-link" onClick={() => onSelectAll(selected.size < group.rows.length)}>
        {selected.size < group.rows.length ? t("tools.geocode.addr.moveAll") : t("tools.geocode.addr.moveNone")}
      </button>
      <button
        data-busy-cursor
        className="nav-btn primary tools-place-rename-apply"
        onClick={onApply}
        disabled={!pick || selected.size === 0}
      >
        {t("tools.geocode.addr.bulkApply", { count: selected.size })}
      </button>
      <button className="nav-btn" onClick={onCancel}>
        {t("tools.places.rename.cancel")}
      </button>
    </div>
  );
}
