import { useTranslation } from "react-i18next";
import type { PlaceProposal } from "../../geo/placeProposal";
import { SuggestInput } from "../edit/SuggestInput";
import { usePlaceLookup } from "../edit/PlaceLookupContext";
import type { FieldSuggestions } from "../edit/fieldSuggestions";
import type { PlaceGroup } from "./useAddressCoordRows";

/**
 * Move the ticked addresses of one place to another place. The destination is a
 * whole PLAC value, autocompleted from the ones the file already uses so a split
 * lands on an existing spelling rather than a near-duplicate — and, for the case
 * this panel exists for, looked up in the registers: a hamlet the file has only
 * ever filed under its neighbour is by definition a place the file cannot spell
 * yet, and the register knows its chain and where it is.
 */
export function MovePanel({
  group,
  target,
  selected,
  places,
  autoFocus,
  onTarget,
  onPickProposal,
  onSelectAll,
  onApply,
  onCancel,
}: {
  group: PlaceGroup;
  target: string;
  selected: ReadonlySet<string>;
  places: FieldSuggestions;
  /** Whether the destination field takes the keyboard as it appears — true for
   *  the click that opens the panel, false when a filtered-out group brings its
   *  open panel back with it. */
  autoFocus: boolean;
  onTarget: (value: string) => void;
  onPickProposal: (proposal: PlaceProposal) => void;
  onSelectAll: (all: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const lookup = usePlaceLookup();
  const trimmed = target.trim();
  const events = group.rows.filter((r) => selected.has(r.key)).reduce((n, r) => n + r.count, 0);
  const disabled = !trimmed || trimmed === group.place || selected.size === 0;

  return (
    <div
      className="tools-place-rename tools-geo-addr-move"
      onKeyDown={(e) => {
        // Enter on a highlighted suggestion, and Escape with the dropdown open,
        // belong to the autocomplete (defaultPrevented); the next press is the
        // panel's, exactly as in the rename row above.
        if (e.key === "Enter" && !e.defaultPrevented && !disabled) onApply();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <p className="tools-intro">{t("tools.geocode.addr.moveIntro")}</p>
      <SuggestInput
        value={target}
        suggestions={places.placeSuggestions}
        canonical={places.placeCanonical}
        isDirty={false}
        className="tools-place-rename-input"
        wrapClassName="tools-place-rename-auto"
        placeholder={t("tools.geocode.addr.movePlaceholder")}
        autoFocus={autoFocus}
        onChange={onTarget}
        onCommit={onTarget}
        onClear={() => onTarget("")}
        onPickProposal={onPickProposal}
        onLookup={lookup ? (query) => lookup.search(query) : undefined}
        lookupNote={lookup && !lookup.online ? t("event.place.lookup.offlineOnly") : undefined}
      />
      <span className="tools-place-rename-hint">
        {t("tools.geocode.addr.moveCount", { count: selected.size, events })}
      </span>
      <button className="tools-issue-link" onClick={() => onSelectAll(selected.size < group.rows.length)}>
        {selected.size < group.rows.length ? t("tools.geocode.addr.moveAll") : t("tools.geocode.addr.moveNone")}
      </button>
      <button data-busy-cursor className="nav-btn primary tools-place-rename-apply" onClick={onApply} disabled={disabled}>
        {t("tools.geocode.addr.moveApply", { count: selected.size })}
      </button>
      <button className="nav-btn" onClick={onCancel}>
        {t("tools.places.rename.cancel")}
      </button>
    </div>
  );
}
