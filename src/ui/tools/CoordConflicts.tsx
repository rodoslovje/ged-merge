import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { scanPlaceCoords, type CoordConflict } from "../../tools/placeCoords";
import { placeAddrKey } from "../../tools/geocode";
import { parseManualCoord } from "./GeocodePlaceRow";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { ExpandAllToggle, GeoRowHeader, MapToggle } from "./shared";

const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

/** The row's identity — the pair it is about, and the write-back key. */
const keyOf = (c: CoordConflict) => placeAddrKey(c.value, c.address);

/**
 * Same place and same address, yet different coordinates — one location
 * described two ways. Different addresses in one settlement are *not* listed;
 * those legitimately differ, which is the whole point of keying by place +
 * address.
 *
 * It lives on the geocode page rather than in the health check because that is
 * where coordinates are read, compared and written — and because settling one is
 * a map question. Expanding a row draws its coordinates as numbered pins (the
 * number being how many events sit there), so the outlier is obvious: twelve
 * events on the church and one 2 km off is a typo, not a second church. Choosing
 * a pin rewrites every event of the pair to it, in one undoable step.
 *
 * The right answer is not always one of the two, so a point clicked anywhere on
 * the map — or a coordinate typed or pasted in — counts as a third candidate:
 * where a maternity hospital ended up recorded at three different guesses, none
 * of them is the hospital.
 */
export function CoordConflicts({
  dataset,
  onApply,
}: {
  dataset: Dataset;
  /** Write one coordinate onto every event at a place+address pair, replacing
   *  what is there — the same overwriting write-back the address register uses. */
  onApply: (assignments: Map<string, GeoCoord>) => number;
}) {
  const { t } = useTranslation();
  // Re-scanned whenever the dataset object changes, so a settled row disappears.
  const conflicts = useMemo(() => scanPlaceCoords(dataset).conflicts, [dataset]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** The row whose map is drawn — one at a time, and only on request. */
  const [mapOpen, setMapOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, GeoCoord>>(new Map());
  /** Free "lat, lon" text per row, for a coordinate that is in neither list. */
  const [manual, setManual] = useState<Map<string, string>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);

  if (!conflicts.length) return null;

  // Only the rows actually rendered can be opened, so they are what "all" means.
  const shown = conflicts.slice(0, 200);
  const allOpen = shown.every((c) => open.has(keyOf(c)));

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setApplied(null);
  };

  const pick = (key: string, coord: GeoCoord) => setPicked((prev) => new Map(prev).set(key, coord));

  /** Clicking the chosen option again drops the choice — a radio group has no
   *  "none" of its own, and a row picked by mistake would otherwise be written. */
  const unpick = (key: string) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

  /** A point off the map's own pins: remembered as text so the row shows what
   *  was picked, and chosen in the same move. */
  const pickPoint = (key: string, coord: GeoCoord) => {
    setManual((prev) => new Map(prev).set(key, `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`));
    pick(key, coord);
  };

  /** Settle every row that has a pick, in one undoable step — the same shape as
   *  the two lists above, which also collect picks and write them together. */
  const apply = () => {
    if (!picked.size) return;
    const changed = onApply(new Map(picked));
    setPicked(new Map());
    setManual(new Map());
    setOpen(new Set());
    setMapOpen(null);
    setApplied(changed);
  };

  return (
    <section className="tools-cleanup-section">
      <div className="tools-dup-kind-head">
        {t("tools.validate.coordConflict.title")}
        <span className="tools-chip-count">{conflicts.length}</span>
        <div className="tools-dup-bulk">
          <button className="nav-btn primary tools-run" onClick={apply} disabled={!picked.size}>
            {t("tools.validate.coordConflict.apply", { count: picked.size })}
          </button>
          <button className="tools-issue-link" onClick={() => setPicked(new Map())} disabled={!picked.size}>
            {t("tools.sources.dupSelectNone")}
          </button>
          <ExpandAllToggle
            allOpen={allOpen}
            onToggle={() => {
              if (allOpen) {
                setOpen(new Set());
                setMapOpen(null);
              } else setOpen(new Set(shown.map(keyOf)));
            }}
          />
        </div>
      </div>
      <p className="tools-intro">{t("tools.validate.coordConflict.hint", { count: conflicts.length })}</p>
      {applied !== null && (
        <p className="tools-clean tools-clean--ok">{t("tools.validate.coordConflict.applied", { count: applied })}</p>
      )}
      <ul className="tools-tree">
        {shown.map((c) => {
          const key = keyOf(c);
          const isOpen = open.has(key);
          const chosen = picked.get(key);
          const manualText = manual.get(key) ?? "";
          const manualCoord = parseManualCoord(manualText);
          const manualChosen = !!manualCoord && sameCoord(chosen, manualCoord);
          return (
            <li key={key} className="tools-tree-node">
              {/* The coordinates themselves are the row's options, listed once
                  it opens — repeating them here only crowds the name. */}
              <GeoRowHeader open={isOpen} onToggle={() => toggle(key)} place={c.value} address={c.address}>
                <span className="tools-geo-count">
                  {t("tools.validate.coordConflict.rowMeta", {
                    count: c.coords.length,
                    events: c.coords.reduce((n, x) => n + x.n, 0),
                  })}
                </span>
              </GeoRowHeader>
              {isOpen && (
                <div className="tools-geo-conflict-body">
                  <div className="tools-geo-actions">
                    <MapToggle open={mapOpen === key} onToggle={() => setMapOpen(mapOpen === key ? null : key)} />
                  </div>
                  {mapOpen === key && (
                  <Suspense fallback={<div className="tools-geo-minimap" />}>
                    <MiniPlaceMap
                      pins={[
                        ...c.coords.map(
                          (x): MiniMapPin => ({
                            coord: x.coord,
                            label: `${x.coord.lat.toFixed(5)}, ${x.coord.lon.toFixed(5)}`,
                            lines: [t("tools.geocode.addr.uses", { count: x.n }), t("event.coord.pinPick")],
                            badge: x.n,
                            kind: sameCoord(chosen, x.coord) ? "chosen" : "candidate",
                            onPick: () => pick(key, x.coord),
                          }),
                        ),
                        // A point of the researcher's own carries no count — it
                        // is where the events *should* be, not where any is.
                        ...(manualCoord && !c.coords.some((x) => sameCoord(x.coord, manualCoord))
                          ? [
                              {
                                coord: manualCoord,
                                label: t("tools.geocode.manual"),
                                kind: manualChosen ? ("chosen" as const) : ("candidate" as const),
                                onPick: () => pick(key, manualCoord),
                              },
                            ]
                          : []),
                      ]}
                      onPickCoord={(coord) => pickPoint(key, coord)}
                      title={t("tools.validate.coordConflict.mapPickHint")}
                      fitKey={key}
                    />
                  </Suspense>
                  )}
                  <ul className="tools-geo-candidates">
                    {c.coords.map((x, j) => (
                      <li key={j}>
                        <label>
                          <input
                            type="radio"
                            name={`conflict-${key}`}
                            checked={sameCoord(chosen, x.coord)}
                            onChange={() => pick(key, x.coord)}
                            onClick={() => sameCoord(chosen, x.coord) && unpick(key)}
                          />
                          <span className="gm-data">
                            {x.coord.lat.toFixed(5)}, {x.coord.lon.toFixed(5)}
                          </span>
                          <span className="tools-geo-count">{t("tools.geocode.addr.uses", { count: x.n })}</span>
                        </label>
                      </li>
                    ))}
                    {/* Neither of the file's coordinates need be right: click the
                        map, or type/paste one, and it joins the choice. */}
                    <li className="tools-geo-manual">
                      <label>
                        <input
                          type="radio"
                          name={`conflict-${key}`}
                          checked={manualChosen}
                          disabled={!manualCoord}
                          onChange={() => manualCoord && pick(key, manualCoord)}
                          onClick={() => manualChosen && unpick(key)}
                        />
                        <span className="tools-geo-cand-name">{t("tools.geocode.manual")}</span>
                      </label>
                      <input
                        type="text"
                        placeholder={t("tools.geocode.manualPlaceholder")}
                        title={t("tools.geocode.manualTooltip")}
                        value={manualText}
                        onChange={(e) => {
                          const text = e.target.value;
                          setManual((prev) => new Map(prev).set(key, text));
                          const coord = parseManualCoord(text);
                          if (coord) pick(key, coord);
                        }}
                      />
                    </li>
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {conflicts.length > 200 && (
        <p className="tools-fix-hint">{t("tools.geocode.more", { count: conflicts.length - 200 })}</p>
      )}
    </section>
  );
}
