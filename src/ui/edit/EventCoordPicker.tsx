import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeoCoord } from "../../gedcom/types";
import { parseCoordInput } from "../../gedcom/place";
import { rnQueryFrom, searchAddress, type RnResult } from "../../geo/rn";
import { useSettings } from "../SettingsContext";

// Per-event coordinate control in the Edit view: the pin beside a place, and the
// small panel it opens.
//
// The Tools list only offers places that are *missing* coordinates, which leaves
// the case this covers — a place already pinned at its settlement, whose address
// could be pinned at the actual house. That refinement is per event (one Kranj
// event may name a different address than the next), which is exactly the grain
// the Edit view works at.

export function EventCoordPicker({
  place,
  address,
  coord,
  title,
  onPick,
  onClear,
}: {
  /** The event's current place text (as edited). */
  place: string;
  /** The event's current address text (as edited). */
  address: string;
  /** Coordinate the event carries, when it has one. */
  coord: GeoCoord | undefined;
  /** Tooltip for the pin, naming the event. */
  title: string;
  onPick: (coord: GeoCoord) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState<{ state: "idle" | "loading" | "error" | "done"; results: RnResult[] }>({
    state: "idle",
    results: [],
  });
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const query = useMemo(() => rnQueryFrom(place || undefined, address || undefined), [place, address]);
  const draftCoord = parseCoordInput(draft);

  // Close on Escape or a click elsewhere, like the other inline Edit pickers.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const runSearch = () => {
    if (!query) return;
    setSearch({ state: "loading", results: [] });
    searchAddress(query).then(
      (results) => setSearch({ state: "done", results }),
      () => setSearch({ state: "error", results: [] }),
    );
  };

  const take = (c: GeoCoord) => {
    onPick(c);
    setOpen(false);
    setSearch({ state: "idle", results: [] });
    setDraft("");
  };

  // Nothing to offer and nothing to show: no pin at all, so an unplaceable
  // event stays visually quiet.
  if (!coord && !query && !place) return null;

  return (
    <span className="edit-event-coord-wrap" ref={boxRef}>
      <button
        type="button"
        className={"edit-event-coord" + (coord ? "" : " edit-event-coord--empty")}
        title={
          coord
            ? t("event.coord", { coords: `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}` })
            : t("event.coord.none", { event: title })
        }
        aria-label={t("event.coord.open", { event: title })}
        onClick={() => setOpen((v) => !v)}
      >
        📍
      </button>
      {open && (
        <div className="edit-coord-pop">
          {coord && (
            <div className="edit-coord-current">
              <span className="gm-data">
                {coord.lat.toFixed(5)}, {coord.lon.toFixed(5)}
              </span>
              <button type="button" className="tools-issue-link" onClick={() => { onClear(); setOpen(false); }}>
                {t("event.coord.clear")}
              </button>
            </div>
          )}
          {query ? (
            settings.allowLinkFetch ? (
              <>
                <button type="button" className="tools-issue-link" disabled={search.state === "loading"} onClick={runSearch}>
                  {search.state === "loading" ? t("tools.geocode.rn.searching") : t("tools.geocode.rn.search")}
                </button>
                {search.state === "error" && <p className="edit-coord-note">{t("tools.geocode.rn.error")}</p>}
                {search.state === "done" && !search.results.length && <p className="edit-coord-note">{t("tools.geocode.rn.none")}</p>}
                {search.results.length > 0 && (
                  <ul className="edit-coord-results">
                    {search.results.map((r, i) => (
                      <li key={i}>
                        <button type="button" className="tools-issue-link" title={r.label} onClick={() => take(r.coord)}>
                          {r.label}
                        </button>
                        <span className="gm-data">
                          {r.coord.lat.toFixed(5)}, {r.coord.lon.toFixed(5)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="edit-coord-note">{t("tools.geocode.downloadNeedsOptIn")}</p>
            )
          ) : (
            <p className="edit-coord-note">{t("event.coord.noHouseNumber")}</p>
          )}
          <div className="edit-coord-manual">
            <input
              type="text"
              value={draft}
              placeholder={t("event.coord.manualPlaceholder")}
              title={t("event.coord.manual")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftCoord) {
                  e.preventDefault();
                  take(draftCoord);
                }
              }}
            />
            <button type="button" className="tools-issue-link" disabled={!draftCoord} onClick={() => draftCoord && take(draftCoord)}>
              {t("event.coord.set")}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
