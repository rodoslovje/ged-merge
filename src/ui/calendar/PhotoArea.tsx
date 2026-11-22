import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { needsFit, scatteredLayout, tidyLayout, type CollageStyle } from "../../calendar/collage";

// A page's picture area: one photo, or a collage of several. One photo fills
// the area when its shape agrees, and otherwise sits whole on a blurred,
// enlarged copy of itself. Several are laid out tidily in rows or scattered
// as leaning prints. Everything is placed in percent, so the print document —
// a copy of this markup — keeps the layout without measuring anything.

export interface PagePhoto {
  url: string;
  caption?: string;
}

/** A scattered print's white border and caption strip, in units of the photo's height. */
const PRINT_BORDER = 0.06;
const PRINT_STRIP = 0.17;

/** Each image's shape (width / height), once it has loaded. */
function useAspects(urls: string[]): Map<string, number> {
  const [aspects, setAspects] = useState<Map<string, number>>(new Map());
  const key = urls.join("\n");
  useEffect(() => {
    let live = true;
    for (const url of key ? key.split("\n") : []) {
      if (aspects.has(url)) continue;
      const img = new Image();
      img.onload = () => {
        if (live && img.naturalHeight) setAspects((m) => new Map(m).set(url, img.naturalWidth / img.naturalHeight));
      };
      img.src = url;
    }
    return () => { live = false; };
  }, [key, aspects]);
  return aspects;
}

/** The area's own shape, measured. */
function useAreaAspect(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { if (el.clientHeight) setAspect(el.clientWidth / el.clientHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, aspect];
}

const pct = (n: number) => `${n.toFixed(3)}%`;

export function PhotoArea({ photos, collage, style }: { photos: PagePhoto[]; collage: CollageStyle; style?: CSSProperties }) {
  const { t } = useTranslation();
  const [ref, areaAspect] = useAreaAspect();
  const aspects = useAspects(photos.map((p) => p.url));

  let body: React.ReactNode;
  if (!photos.length) {
    body = <div className="cal-photo-empty">{t("calendar.noPhoto")}</div>;
  } else if (photos.length === 1) {
    const p = photos[0];
    const a = aspects.get(p.url);
    const fit = a !== undefined && needsFit(a, areaAspect);
    body = (
      <>
        {fit && <img className="cal-photo-blur" src={p.url} alt="" />}
        <img className={fit ? "cal-photo-fit" : "cal-photo-fill"} src={p.url} alt="" />
        {p.caption && <div className="cal-caption">{p.caption}</div>}
      </>
    );
  } else if (collage === "tidy") {
    const rects = tidyLayout(photos.map((p) => aspects.get(p.url) ?? 1), areaAspect);
    body = photos.map((p, i) => (
      <div key={i} className="cal-tile" style={{ left: pct(rects[i].x), top: pct(rects[i].y), width: pct(rects[i].w), height: pct(rects[i].h) }}>
        <img src={p.url} alt="" />
        {p.caption && <div className="cal-caption">{p.caption}</div>}
      </div>
    ));
  } else {
    const shapes = photos.map((p) => aspects.get(p.url) ?? 1);
    const printAspect = (a: number) => (a + 2 * PRINT_BORDER) / (1 + PRINT_BORDER + PRINT_STRIP);
    const rects = scatteredLayout(shapes.map(printAspect), areaAspect);
    body = photos.map((p, i) => {
      const a = shapes[i];
      const w = a + 2 * PRINT_BORDER;
      const h = 1 + PRINT_BORDER + PRINT_STRIP;
      const r = rects[i];
      // A print in the upper row is overlapped at its foot by the row below,
      // so its caption goes on top, where it stays readable.
      const upper = rects.some((o) => o !== r && o.y > r.y + r.h / 2);
      const strip = pct((PRINT_STRIP / h) * 100);
      return (
        <div
          key={i}
          className="cal-print"
          style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h), transform: `rotate(${r.rotate ?? 0}deg)` }}
        >
          <img
            src={p.url}
            alt=""
            style={{
              left: pct((PRINT_BORDER / w) * 100),
              top: pct(((upper && p.caption ? PRINT_STRIP : PRINT_BORDER) / h) * 100),
              width: pct((a / w) * 100),
              height: pct((1 / h) * 100),
            }}
          />
          {p.caption && (
            <div className="cal-print-caption" style={upper ? { top: 0, bottom: "auto", height: strip } : { height: strip }}>{p.caption}</div>
          )}
        </div>
      );
    });
  }

  return (
    <div ref={ref} className={`cal-photo${photos.length > 1 ? ` cal-collage cal-collage-${collage}` : ""}`} style={style}>
      {body}
    </div>
  );
}
