import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeoCoord } from "../../gedcom/types";
import { countryCode } from "../../gedcom/countryCode";
import { decomposePlace, parseCoordInput } from "../../gedcom/place";
import { sameCoord } from "../../geo/points";
import { rnQueriesFrom, searchAddresses, type RnResult } from "../../geo/rn";
import { searchNominatim, type NominatimResult } from "../../geo/nominatim";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { PinIcon } from "../icons/PinIcon";
import { useSettingsSlice } from "../SettingsContext";
import { useCoordShare } from "./CoordShareContext";
import { usePhone } from "../usePhone";

// Per-event coordinate control in the Edit view: the pin beside a place, and the
// small panel it opens.
//
// The Tools list only offers places that are *missing* coordinates, which leaves
// the case this covers — a place already pinned at its settlement, whose address
// could be pinned at the actual house. That refinement is per event (one Kranj
// event may name a different address than the next), which is exactly the grain
// the Edit view works at.
//
// Two lookups, because the address register is Slovenia-only: GURS for a
// Slovenian house number (exact, official), and Nominatim for anywhere else —
// so a Vienna or Chicago address is served too. Both sit behind the same
// online-lookups opt-in and only run on their button.

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["allowLinkFetch"] as const;

const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

type Search<T> = { state: "idle" | "loading" | "error" | "done"; results: T[] };

const IDLE = { state: "idle" as const, results: [] };

/** Keep the panel this far from the window edges. */
const EDGE = 8;
/** Least room worth opening the phone panel into — map, manual entry and a
 *  couple of results. Below this the row is scrolled up to make space. */
const MIN_PHONE_PANEL = 330;

export function EventCoordPicker({
  place,
  address,
  coord,
  title,
  fileCoord,
  filePairCoord,
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
  /** Coordinate this place already carries elsewhere in the file (settlement
   *  level), when it has one. Offline, already reviewed by the user — so it is
   *  offered first, ahead of any lookup. */
  fileCoord?: GeoCoord;
  /** Coordinate this exact place+address already carries elsewhere in the file —
   *  the same house, so better still. */
  filePairCoord?: GeoCoord;
  /** `label` names where the coordinate came from (the register hit, the file,
   *  "manual") — for callers that stage a pick and show its origin. */
  onPick: (coord: GeoCoord, label?: string) => void;
  onClear: () => void;
}) {
  const { t, i18n } = useTranslation();
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const [open, setOpen] = useState(false);
  const [rn, setRn] = useState<Search<RnResult>>(IDLE);
  const [osm, setOsm] = useState<Search<NominatimResult>>(IDLE);
  const [draft, setDraft] = useState("");
  /** Where the panel is pinned in the viewport. It is positioned fixed and
   *  clamped to the window: the events table scrolls sideways and clips, so an
   *  absolutely positioned panel was cut off at either edge. */
  const [pos, setPos] = useState<{ left?: number; top: number; maxH?: number } | null>(null);
  /** Whether the next pick is copied to the file's other events at this exact
   *  place and address (see the offer in the panel head). On by default: the
   *  same place and address is the same house, so one position is what those
   *  events should all have — unticking is the exception. */
  const [shareAll, setShareAll] = useState(true);
  const share = useCoordShare();
  const phone = usePhone();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const queries = useMemo(() => rnQueriesFrom(place || undefined, address || undefined), [place, address]);
  /** Whether the register could ever apply here — Slovenia, or no country named. */
  const inSlovenia = useMemo(() => {
    const named = decomposePlace(address || place).country ?? decomposePlace(place).country;
    return !named || countryCode(named)?.toUpperCase() === "SI";
  }, [place, address]);
  const draftCoord = parseCoordInput(draft);
  /** One coordinate, as the panel and the pin panels print it. */
  const at = (c: GeoCoord) => `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = boxRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const below = anchor.bottom + 4;
      if (phone) {
        // Always *below* the row, never flipped above it: the place and address
        // being positioned have to stay in view, or there is no telling what the
        // map is pinning. The width comes from CSS (screen less a margin), and
        // whatever room is left below becomes the panel's height — it scrolls
        // inside rather than growing off the bottom of the screen.
        const maxH = Math.max(window.innerHeight - below - EDGE, MIN_PHONE_PANEL);
        setPos((prev) => (prev && prev.top === below && prev.maxH === maxH ? prev : { top: below, maxH }));
        return;
      }
      const panel = popRef.current?.getBoundingClientRect();
      const width = panel?.width ?? Math.min(720, window.innerWidth * 0.92);
      const height = panel?.height ?? 320;
      const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - width - EDGE));
      // Below the pin, or above it when the window has no room underneath.
      const top = below + height > window.innerHeight - EDGE ? Math.max(EDGE, anchor.top - height - 4) : below;
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    position();
    // The panel grows as lookups return; re-place it so it stays on screen.
    const ro = new ResizeObserver(position);
    if (popRef.current) ro.observe(popRef.current);
    window.addEventListener("resize", position);
    // Capture: the events area scrolls, not the window.
    window.addEventListener("scroll", position, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, phone]);

  // Opened from a row near the foot of a phone screen there is nowhere below it
  // to put the panel. Scroll the row up once, so it keeps its place above a
  // panel that gets a usable height. The scroll listener above re-places it.
  useEffect(() => {
    if (!open || !phone) return;
    const anchor = boxRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const short = MIN_PHONE_PANEL - (window.innerHeight - anchor.bottom - EDGE);
    if (short > 0) window.scrollBy({ top: short, behavior: "smooth" });
  }, [open, phone]);

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
      const target = e.target as Node;
      // The panel is a fixed-position sibling, so it is not inside boxRef.
      if (popRef.current?.contains(target)) return;
      if (boxRef.current && !boxRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const runRegister = () => {
    if (!queries.length) return;
    setRn({ state: "loading", results: [] });
    searchAddresses(queries).then(
      (results) => setRn({ state: "done", results }),
      () => setRn({ state: "error", results: [] }),
    );
  };

  const runOnline = () => {
    // Address first, then the place, which is how Nominatim reads best.
    const text = [address, place].map((s) => s.trim()).filter(Boolean).join(", ");
    if (!text) return;
    setOsm({ state: "loading", results: [] });
    searchNominatim(text, i18n.language).then(
      (results) => setOsm({ state: "done", results }),
      () => setOsm({ state: "error", results: [] }),
    );
  };

  // Other events in the file at this very place and address: their coordinate
  // should be the same one, so picking here offers to set theirs too.
  const others = share ? share.countOthers(place, address) : 0;

  /** What the file itself already knows about this address / place. Anything
   *  equal to the current coordinate is left out — it would propose a no-op. */
  const fromFile: { coord: GeoCoord; label: string }[] = [];
  if (filePairCoord && !sameCoord(filePairCoord, coord)) {
    fromFile.push({ coord: filePairCoord, label: t("event.coord.fromFile.address") });
  }
  if (fileCoord && !sameCoord(fileCoord, coord) && !sameCoord(fileCoord, filePairCoord)) {
    fromFile.push({ coord: fileCoord, label: t("event.coord.fromFile.place") });
  }

  // `label` says where the coordinate came from, and the lists that stage a
  // pick print it — so it must stay a short name of the source ("manual", the
  // register's address line), never a field's help text.
  const take = (c: GeoCoord, label: string) => {
    onPick(c, label);
    // The same house serves every event at this place and address, so the
    // offer copies the pick to them in one further undoable step.
    if (shareAll && others > 0) share!.applyToAll(place, address, c);
    setOpen(false);
    setRn(IDLE);
    setOsm(IDLE);
    setDraft("");
  };

  // Candidate pins plus whatever is currently chosen. Each carries `lines`, so
  // the map renders its detail panel (house, post office, source, and that a
  // click takes it) rather than a bare one-line tooltip — with several numbers
  // of one renumbered house on screen, the panel is what tells them apart. The
  // coordinate is not among the lines: the panel prints every pin's own
  // position as its closing row already.
  const pins: MiniMapPin[] = [];
  for (const f of fromFile) {
    pins.push({
      coord: f.coord,
      label: f.label,
      lines: [t("event.coord.source.file"), t("event.coord.pinPick")],
      kind: "candidate",
      onPick: () => take(f.coord, f.label),
    });
  }
  for (const r of rn.results) {
    pins.push({
      coord: r.coord,
      label: r.address,
      lines: [r.label === r.address ? "" : r.label, t("event.coord.source.gurs"), t("event.coord.pinPick")].filter(Boolean),
      kind: "candidate",
      onPick: () => take(r.coord, r.label),
    });
  }
  for (const r of osm.results) {
    if (pins.some((p) => sameCoord(p.coord, r.coord))) continue;
    pins.push({
      coord: r.coord,
      label: r.name,
      lines: [r.label === r.name ? "" : r.label, t("event.coord.source.osm"), t("event.coord.pinPick")].filter(Boolean),
      kind: "candidate",
      onPick: () => take(r.coord, r.name),
    });
  }
  if (draftCoord && !pins.some((p) => sameCoord(p.coord, draftCoord))) {
    pins.push({ coord: draftCoord, label: t("event.coord.typed"), kind: "chosen" });
  } else if (coord && !pins.some((p) => sameCoord(p.coord, coord))) {
    pins.push({ coord, label: t("event.coord.current"), kind: "chosen" });
  }

  // Nothing to place and nothing to show: no pin at all, so an event that names
  // no place stays visually quiet.
  if (!coord && !place) return null;

  const busy = rn.state === "loading" || osm.state === "loading";


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
        <PinIcon />
      </button>
      {open && (
        <div
          ref={popRef}
          className={"edit-coord-pop" + (phone ? " edit-coord-pop--phone" : "")}
          // On a phone `left`/`right` come from CSS (the panel spans the screen
          // less a margin), so only the anchored top and the height it may use
          // are set here.
          style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxH } : { visibility: "hidden" }}
        >
          {/* Head: what the event carries now, and the manual entry that can
              replace it — the two things that act on the value itself. */}
          <div className="edit-coord-head">
            {coord && (
              <div className="edit-coord-current">
                <span className="gm-data gm-coord gm-coord--set">
                  {coord.lat.toFixed(5)}, {coord.lon.toFixed(5)}
                </span>
                <button type="button" className="tools-issue-link" onClick={() => { onClear(); setOpen(false); }}>
                  {t("event.coord.clear")}
                </button>
              </div>
            )}
            {others > 0 && (
              <label className="edit-coord-share" title={t("event.coord.applyAll.hint")}>
                <input type="checkbox" checked={shareAll} onChange={(e) => setShareAll(e.target.checked)} />
                {t("event.coord.applyAll", { count: others })}
              </label>
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
                    take(draftCoord, t("tools.geocode.manual"));
                  }
                }}
              />
              <button
                type="button"
                className="tools-issue-link"
                disabled={!draftCoord}
                onClick={() => draftCoord && take(draftCoord, t("tools.geocode.manual"))}
              >
                {t("event.coord.set")}
              </button>
            </div>
          </div>

          {/* Body: the map to pick on, and the candidates to pick from. */}
          <div className="edit-coord-body">
            {/* Candidate pins are clickable, and a click on the background fills
                the manual field rather than writing straight away — in Edit a
                pick is a file change, so it stays one deliberate confirmation. */}
            {(pins.length > 0 || coord) && (
              <Suspense fallback={<div className="edit-coord-map" />}>
                <div className="edit-coord-map">
                  <MiniPlaceMap
                    pins={pins}
                    title={t("event.coord.mapHint")}
                    // Keyed on the found coordinates, so each new result set
                    // re-frames the map around all of them — a renumbered house
                    // can be two addresses a kilometre apart. The typed draft is
                    // deliberately left out: re-fitting on every keystroke would
                    // make the map jump while someone is still typing.
                    fitKey={
                      [...rn.results, ...osm.results].map((r) => `${r.coord.lat},${r.coord.lon}`).join("|") ||
                      `${place} ${address}`
                    }
                    onPickCoord={(c) => setDraft(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`)}
                  />
                </div>
              </Suspense>
            )}

            <div className="edit-coord-side">
              {fromFile.length > 0 && (
                <ul className="edit-coord-results">
                  {fromFile.map((f, i) => (
                    <li key={`file-${i}`}>
                      <button type="button" className="tools-issue-link" onClick={() => take(f.coord, f.label)}>
                        {f.label}
                      </button>
                      <span className="gm-data">{at(f.coord)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {settings.allowLinkFetch ? (
                <div className="edit-coord-actions">
                  {queries.length > 0 && (
                    <button type="button" className="tools-issue-link" disabled={busy} onClick={runRegister}>
                      {rn.state === "loading" ? t("tools.geocode.rn.searching") : t("tools.geocode.rn.search")}
                    </button>
                  )}
                  <button type="button" className="tools-issue-link" disabled={busy} onClick={runOnline}>
                    {osm.state === "loading" ? t("tools.geocode.online.searching") : t("tools.geocode.online.search")}
                  </button>
                </div>
              ) : (
                <p className="edit-coord-note">{t("tools.geocode.downloadNeedsOptIn")}</p>
              )}
              {rn.state === "error" && <p className="edit-coord-note">{t("tools.geocode.rn.error")}</p>}
              {rn.state === "done" && !rn.results.length && <p className="edit-coord-note">{t("tools.geocode.rn.none")}</p>}
              {osm.state === "error" && <p className="edit-coord-note">{t("tools.geocode.online.error")}</p>}
              {osm.state === "done" && !osm.results.length && (
                <p className="edit-coord-note">{t("tools.geocode.online.none")}</p>
              )}
              {/* Why the register isn't on offer — only where it could have been:
                  a Slovenian place just needs a house number. Anywhere else the
                  register was never a candidate, so saying so is noise. */}
              {settings.allowLinkFetch && !queries.length && inSlovenia && (
                <p className="edit-coord-note">{t("event.coord.noHouseNumber")}</p>
              )}

              {(rn.results.length > 0 || osm.results.length > 0) && (
                <ul className="edit-coord-results">
                  {rn.results.map((r, i) => (
                    <li key={`rn-${i}`}>
                      <button type="button" className="tools-issue-link" title={r.label} onClick={() => take(r.coord, r.label)}>
                        {r.label}
                      </button>
                      <span className="gm-data gm-coord">
                        {r.coord.lat.toFixed(5)}, {r.coord.lon.toFixed(5)}{" "}
                        <span className="tools-reshape-badge official">GURS</span>
                      </span>
                    </li>
                  ))}
                  {osm.results.map((r, i) => (
                    <li key={`osm-${i}`}>
                      <button type="button" className="tools-issue-link" title={r.label} onClick={() => take(r.coord, r.name)}>
                        {r.label}
                      </button>
                      <span className="gm-data gm-coord">
                        {r.coord.lat.toFixed(5)}, {r.coord.lon.toFixed(5)}{" "}
                        <span className="tools-reshape-badge reuse">OSM</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
