import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CALLOUT, layoutCallouts, mapFlags, mapRegions, type MapPin } from "../../calendar/mapPins";
import { BASEMAP_CREDIT, renderBasemap, type Basemap, type MapShape } from "./basemap";

// The calendar's map: a base map of the places the family lives at, a dot on
// each, and a box in a column at the side of the map — the place and the
// names — tied to its dot by a line. A family that lives in several regions
// far apart gets a map of each. The base map is a picture; the dots, lines
// and boxes are the page's own, so they print as sharp as the rest of it and
// follow its colours.

/** How many far-off places the line under the maps names. */
const AWAY_PLACES = 8;
/** A map's foot kept free of boxes, for the credit. */
const FOOT_EM = 1;
/** A box's distance from the map's edge, in em (the stylesheet's). */
const EDGE_EM = 0.5;
/** What a column of boxes takes of a map's width, in em, a little air included. */
const COLUMN_EM = EDGE_EM + CALLOUT.width + 1.5;
/** A map narrower than this has one column of boxes, not two. */
const TWO_COLUMNS_EM = 30;
/** What a further region's map needs beside the first, in em: its width in a
 *  wide picture, or its height — and the first one's — in a tall one. */
const BRANCH_WIDTH_EM = 20;
const BRANCH_HEIGHT_EM = 9;
const HOME_HEIGHT_EM = 24;
/** The least share of the picture a region's map gets, however few live there. */
const MIN_SHARE = 0.3;

interface Props {
  pins: MapPin[];
  /** A person's name, as the calendar writes the living. */
  nameOf: (id: string) => string;
}

export function MapPicture({ pins, nameOf }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // Several maps stand side by side in a wide picture, one above the other in a tall one.
  // Known only once the picture's room is measured; the maps wait for it, as
  // each measures its own share of that room.
  const [room, setRoom] = useState<{ wide: boolean; maps: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    const em = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    if (!el || !em || !el.clientHeight) return;
    const wide = el.clientWidth / el.clientHeight > 1.2;
    // The first map keeps what its two columns of boxes need; every further
    // one needs a column and some map beside it, or a few lines of height.
    const spare = wide ? (el.clientWidth / em - TWO_COLUMNS_EM) / BRANCH_WIDTH_EM : (el.clientHeight / em - HOME_HEIGHT_EM) / BRANCH_HEIGHT_EM;
    setRoom({ wide, maps: 1 + Math.max(0, Math.floor(spare)) });
  }, []);
  // A map of each region the family lives in, the most peopled first and
  // largest; whoever lives beyond them is named in a line under the maps.
  const { regions, away } = useMemo(() => mapRegions(pins, room?.maps ?? 1), [pins, room]);
  if (!pins.length) return <div className="cal-map" ref={ref}><div className="cal-photo-empty">{t("calendar.map.empty")}</div></div>;
  const people = regions.map((r) => r.reduce((n, p) => n + p.ids.length, 0));
  const total = people.reduce((a, b) => a + b, 0);
  return (
    <div className="cal-maps-wrap">
      <div className={`cal-maps${room?.wide === false ? " cal-maps-stacked" : ""}`} ref={ref}>
        {room && regions.map((region, i) => (
          <MapPanel key={region.map((p) => p.place).join("|")} pins={region} nameOf={nameOf} grow={Math.max(MIN_SHARE, people[i] / total)} />
        ))}
      </div>
      {room && away.length > 0 && (
        <div className="cal-map-away">
          <i>{t("calendar.map.elsewhere")}:</i>{" "}
          {away.slice(0, AWAY_PLACES).map((p, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <b>{p.place}</b> {p.ids.slice(0, CALLOUT.names).map(nameOf).join(", ")}
              {p.ids.length > CALLOUT.names && ` +${p.ids.length - CALLOUT.names}`}
            </span>
          ))}
          {away.length > AWAY_PLACES && ` · +${away.length - AWAY_PLACES}`}
        </div>
      )}
    </div>
  );
}

/** One region's map, with its boxes. */
function MapPanel({ pins, nameOf, grow }: Props & { grow: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // The picture is drawn in the shape of the room the page gives it, and the
  // boxes laid out in the page's em.
  const [size, setSize] = useState<{ aspect: number; w: number; h: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    const em = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    if (!el || !em || !el.clientWidth || !el.clientHeight) return;
    setSize({ aspect: Math.round((el.clientWidth / el.clientHeight) * 20) / 20, w: Math.round(el.clientWidth / em), h: el.clientHeight / em });
  }, []);
  const coords = useMemo(() => pins.map((p) => p.coord), [pins]);
  const oneSide = !!size && size.w < TWO_COLUMNS_EM;
  // The places keep clear of the columns of boxes.
  const shape = useMemo((): MapShape | undefined => {
    if (!size) return undefined;
    const column = Math.min(0.6, COLUMN_EM / size.w);
    return { aspect: size.aspect, widthEm: size.w, clear: oneSide ? [0.08, column] : [column, column] };
  }, [size, oneSide]);
  const [state, setState] = useState<{ of?: Promise<Basemap>; map?: Basemap; failed?: boolean }>({});
  useEffect(() => {
    if (!shape || !coords.length || !renderBasemap) return;
    const of = renderBasemap(coords, shape);
    setState({ of });
    of.then(
      (map) => setState((s) => (s.of === of ? { of, map } : s)),
      () => setState((s) => (s.of === of ? { of, failed: true } : s)),
    );
  }, [coords, shape]);

  let body: React.ReactNode;
  if (state.failed) body = <div className="cal-photo-empty">{t("calendar.map.failed")}</div>;
  else if (!state.map || !size) body = <div className="cal-photo-empty">{t("calendar.map.loading")}</div>;
  else {
    const callouts = layoutCallouts(
      mapFlags(pins, state.map.spots, size.aspect), size.w, size.h, FOOT_EM, EDGE_EM, oneSide,
    );
    // Where a line meets its box: the box's inner edge.
    const inner = (EDGE_EM + CALLOUT.width) / size.w;
    body = (
      <>
        <img src={state.map.url} alt="" />
        <svg className="cal-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {callouts.map((c, i) => (
            <line key={i} x1={c.x * 100} y1={c.y * 100} x2={(c.side === "left" ? inner : 1 - inner) * 100} y2={c.tie * 100} />
          ))}
        </svg>
        {callouts.map((c, i) => <div key={i} className="cal-map-dot" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }} />)}
        {callouts.map((c, i) => (
          <div key={i} className={`cal-flag cal-flag-${c.side}`} style={{ top: `${c.top * 100}%` }}>
            <div className="cal-flag-body">
              {/* With no room for names, the place stands with a count. */}
              <b>{c.place}{c.names === 0 && c.ids.length > 1 && <i> ({c.ids.length})</i>}</b>
              {c.ids.slice(0, c.names).map((id) => <span key={id}>{nameOf(id)}</span>)}
              {c.names > 0 && c.ids.length > c.names && <span>+{c.ids.length - c.names}</span>}
            </div>
          </div>
        ))}
        <div className="cal-map-credit">{BASEMAP_CREDIT}</div>
      </>
    );
  }
  return <div className="cal-map" ref={ref} style={{ flexGrow: grow }}>{body}</div>;
}
