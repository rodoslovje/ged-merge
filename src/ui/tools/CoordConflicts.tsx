import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { scanPlaceCoords, type CoordConflict } from "../../tools/placeCoords";
import { placeAddrKey } from "../../tools/geocode";
import { parseManualCoord } from "./GeocodePlaceRow";
import type { MiniMapPin } from "../map/MiniPlaceMap";

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
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, GeoCoord>>(new Map());
  /** Free "lat, lon" text per row, for a coordinate that is in neither list. */
  const [manual, setManual] = useState<Map<string, string>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);

  if (!conflicts.length) return null;

  const toggle = (key: string) => {
    setOpen((prev) => (prev === key ? null : key));
    setApplied(null);
  };

  const pick = (key: string, coord: GeoCoord) => setPicked((prev) => new Map(prev).set(key, coord));

  /** A point off the map's own pins: remembered as text so the row shows what
   *  was picked, and chosen in the same move. */
  const pickPoint = (key: string, coord: GeoCoord) => {
    setManual((prev) => new Map(prev).set(key, `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`));
    pick(key, coord);
  };

  const apply = (c: CoordConflict) => {
    const key = keyOf(c);
    const coord = picked.get(key);
    if (!coord) return;
    const changed = onApply(new Map([[key, coord]]));
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setManual((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setOpen(null);
    setApplied(changed);
  };

  return (
    <section className="tools-cleanup-section">
      <div className="tools-dup-kind-head">{t("tools.validate.coordConflict.title")}</div>
      <p className="tools-intro">{t("tools.validate.coordConflict.hint", { count: conflicts.length })}</p>
      {applied !== null && (
        <p className="tools-clean tools-clean--ok">{t("tools.validate.coordConflict.applied", { count: applied })}</p>
      )}
      <ul className="tools-issues">
        {conflicts.slice(0, 200).map((c, i) => {
          const key = keyOf(c);
          const isOpen = open === key;
          const chosen = picked.get(key);
          const events = c.coords.reduce((n, x) => n + x.n, 0);
          const manualText = manual.get(key) ?? "";
          const manualCoord = parseManualCoord(manualText);
          const manualChosen = !!manualCoord && sameCoord(chosen, manualCoord);
          return (
            <li key={key} className={`tools-issue tools-geo-conflict-row sev-warning${i % 2 ? " zebra" : ""}`}>
              <div className="tools-geo-addr-head">
                <button
                  className={`tools-pair-toggle ${isOpen ? "open" : ""}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(key)}
                >
                  ▶
                </button>
                <span className="tools-issue-msg clickable" onClick={() => toggle(key)}>
                  {c.address ? `${c.value} · ${c.address}` : c.value}
                </span>
                <span className="gm-data">
                  {c.coords.map((x) => `${x.coord.lat.toFixed(4)}, ${x.coord.lon.toFixed(4)} (${x.n})`).join("  ·  ")}
                </span>
              </div>
              {isOpen && (
                <div className="tools-geo-conflict-body">
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
                  <ul className="tools-geo-candidates">
                    {c.coords.map((x, j) => (
                      <li key={j}>
                        <label>
                          <input
                            type="radio"
                            name={`conflict-${key}`}
                            checked={sameCoord(chosen, x.coord)}
                            onChange={() => pick(key, x.coord)}
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
                  <button className="nav-btn tools-run" onClick={() => apply(c)} disabled={!chosen}>
                    {t("tools.validate.coordConflict.apply", { count: events })}
                  </button>
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
