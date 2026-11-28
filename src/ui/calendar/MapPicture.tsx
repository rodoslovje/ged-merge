import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { framePins, mapFlags, type MapPin } from "../../calendar/mapPins";
import { BASEMAP_CREDIT, renderBasemap, type Basemap } from "./basemap";

// The calendar's map: a base map of the places the family lives at, and over
// each a flag with the place and the names. The base map is a picture; the
// flags are the page's own text, so they print as sharp as the rest of it and
// follow its colours.

/** How many names a flag writes out before it counts the rest. */
const FLAG_NAMES = 4;
/** How many far-off places the note beside the map names. */
const AWAY_PLACES = 4;

interface Props {
  pins: MapPin[];
  /** A person's name, as the calendar writes the living. */
  nameOf: (id: string) => string;
}

export function MapPicture({ pins, nameOf }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // The picture is drawn in the shape of the room the page gives it.
  const [aspect, setAspect] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.clientWidth && el.clientHeight) setAspect(Math.round((el.clientWidth / el.clientHeight) * 20) / 20);
  }, []);
  // The map is framed on where most of the family lives; a far-off place is
  // named in a note instead of shrinking everyone else to a dot.
  const { on, away } = useMemo(() => framePins(pins), [pins]);
  const coords = useMemo(() => on.map((p) => p.coord), [on]);
  const names = (ids: string[]) => (
    <>
      {ids.slice(0, FLAG_NAMES).map((id) => <span key={id}>{nameOf(id)}</span>)}
      {ids.length > FLAG_NAMES && <span>+{ids.length - FLAG_NAMES}</span>}
    </>
  );
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
  else if (!state.map || !aspect) body = <div className="cal-photo-empty">{t("calendar.map.loading")}</div>;
  else {
    body = (
      <>
        <img src={state.map.url} alt="" />
        {mapFlags(on, state.map.spots, aspect).map((f, i) => (
          // Near the right edge a flag flies to the left, to stay on the map.
          <div key={i} className={`cal-flag${f.x > 0.72 ? " cal-flag-left" : ""}`} style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%` }}>
            <div className="cal-flag-body">
              <b>{f.place}</b>
              {names(f.ids)}
            </div>
          </div>
        ))}
        {away.length > 0 && (
          <div className="cal-map-away">
            <i>{t("calendar.map.elsewhere")}</i>
            {away.slice(0, AWAY_PLACES).map((p, i) => (
              <div key={i} className="cal-flag-body">
                <b>{p.place}</b>
                {names(p.ids)}
              </div>
            ))}
          </div>
        )}
        <div className="cal-map-credit">{BASEMAP_CREDIT}</div>
      </>
    );
  }
  return <div className="cal-map" ref={ref}>{body}</div>;
}
