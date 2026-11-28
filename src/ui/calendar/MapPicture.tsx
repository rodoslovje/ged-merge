import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CALLOUT, framePins, layoutCallouts, mapFlags, type MapPin } from "../../calendar/mapPins";
import { BASEMAP_CREDIT, renderBasemap, type Basemap } from "./basemap";

// The calendar's map: a base map of the places the family lives at, a dot on
// each, and a box in a column down each side of the map — the place and the
// names — tied to its dot by a line. The base map is a picture; the dots,
// lines and boxes are the page's own, so they print as sharp as the rest of
// it and follow its colours.

/** How many far-off places the line at the map's foot names. */
const AWAY_PLACES = 6;
/** The foot kept free of boxes: the credit alone, or the far-off places too. */
const FOOT_EM = { credit: 1, away: 3.4 };
/** A box's distance from the map's edge, in em (the stylesheet's). */
const EDGE_EM = 0.5;

interface Props {
  pins: MapPin[];
  /** A person's name, as the calendar writes the living. */
  nameOf: (id: string) => string;
}

export function MapPicture({ pins, nameOf }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // The picture is drawn in the shape of the room the page gives it, and the
  // boxes laid out in the page's em.
  const [size, setSize] = useState<{ aspect: number; w: number; h: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    const em = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    if (!el || !em || !el.clientWidth || !el.clientHeight) return;
    setSize({ aspect: Math.round((el.clientWidth / el.clientHeight) * 20) / 20, w: el.clientWidth / em, h: el.clientHeight / em });
  }, []);
  // The map is framed on where most of the family lives; a far-off place is
  // named at its foot instead of shrinking everyone else to a dot.
  const { on, away } = useMemo(() => framePins(pins), [pins]);
  const coords = useMemo(() => on.map((p) => p.coord), [on]);
  const aspect = size?.aspect;
  const [state, setState] = useState<{ of?: Promise<Basemap>; map?: Basemap; failed?: boolean }>({});
  useEffect(() => {
    if (!aspect || !coords.length || !renderBasemap) return;
    const of = renderBasemap(coords, aspect);
    setState({ of });
    of.then(
      (map) => setState((s) => (s.of === of ? { of, map } : s)),
      () => setState((s) => (s.of === of ? { of, failed: true } : s)),
    );
  }, [coords, aspect]);

  let body: React.ReactNode;
  if (!pins.length) body = <div className="cal-photo-empty">{t("calendar.map.empty")}</div>;
  else if (state.failed) body = <div className="cal-photo-empty">{t("calendar.map.failed")}</div>;
  else if (!state.map || !size) body = <div className="cal-photo-empty">{t("calendar.map.loading")}</div>;
  else {
    const callouts = layoutCallouts(mapFlags(on, state.map.spots, size.aspect), size.w, size.h, away.length ? FOOT_EM.away : FOOT_EM.credit, EDGE_EM);
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
        {away.length > 0 && (
          <div className="cal-map-away">
            <i>{t("calendar.map.elsewhere")}:</i>{" "}
            {away.slice(0, AWAY_PLACES).map((p, i) => (
              <span key={i}>
                {i > 0 && " · "}
                <b>{p.place}</b> {p.ids.slice(0, CALLOUT.names).map(nameOf).join(", ")}
                {p.ids.length > CALLOUT.names && ` +${p.ids.length - CALLOUT.names}`}
              </span>
            ))}
          </div>
        )}
        <div className="cal-map-credit">{BASEMAP_CREDIT}</div>
      </>
    );
  }
  return <div className="cal-map" ref={ref}>{body}</div>;
}
