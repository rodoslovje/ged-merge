import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { PublishedTree } from "../publish/model";
import type { PubPhotoLink } from "../publish/photos";
import { useNameOf } from "../ui/SettingsContext";
import { ChevronIcon } from "../ui/icons/ChevronIcon";
import { xrefOf } from "../publish/hydrate";

/** How many photos the front page's strip offers (more than a wide window
 *  shows; the rest scroll in on a phone). */
export const TRAY_SIZE = 40;

/**
 * A photo for each person on the front page: one of them alone where they have
 * it, and a group photo only when it is the one photo they have. People with
 * neither are not offered, and a photo is offered once. Only photos whose
 * folder the author left in the strip count (see `PhotoUse`).
 */
export function trayFaces(tree: PublishedTree): { id: string; link: PubPhotoLink }[] {
  const pagesOnly = new Set((tree.photos ?? []).filter((p) => p.tray === false).map((p) => p.id));
  const peopleOn = new Map<string, number>();
  for (const p of tree.people) for (const l of p.photos ?? []) peopleOn.set(l.photo, (peopleOn.get(l.photo) ?? 0) + 1);
  const out: { id: string; link: PubPhotoLink }[] = [];
  const taken = new Set<string>();
  for (const p of tree.people) {
    const links = (p.photos ?? []).filter((l) => !pagesOnly.has(l.photo));
    const alone = links.find((l) => peopleOn.get(l.photo) === 1);
    const pick = alone ?? (links.length === 1 ? links[0] : undefined);
    if (!pick || taken.has(pick.photo)) continue;
    taken.add(pick.photo);
    out.push({ id: p.id, link: pick });
  }
  return out;
}

/** Fisher–Yates over a copy, `count` long. */
function sample<T>(items: T[], count: number, random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/** A continuous strip of whole photos atop the front page, a new choice on
 *  every visit; the person's name is the photo's tooltip, and a photo opens
 *  their page. It scrolls sideways — by swipe, trackpad, or the arrows at
 *  its ends, each shown while there is more that way. */
export function PhotoTray({ tree, ds, onNavigate }: { tree: PublishedTree; ds: Dataset; onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const faces = useMemo(() => sample(trayFaces(tree), TRAY_SIZE, Math.random), [tree]);
  const pathOf = useMemo(() => new Map((tree.photos ?? []).map((p) => [p.id, p.path])), [tree]);
  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ back: false, on: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const back = el.scrollLeft > 1;
    const on = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.back === back && m.on === on ? m : { back, on }));
  }, []);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, faces]);
  const scroll = (dir: 1 | -1) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  if (!faces.length) return null;
  return (
    <div className="site-tray-wrap">
      {more.back && (
        <button type="button" className="site-tray-arrow site-tray-back" aria-label={t("site.home.photosBack")} onClick={() => scroll(-1)}><ChevronIcon dir="left" size={18} /></button>
      )}
      {/* The edges fade where more photos wait that way. */}
      <div
        className={`site-tray${more.back ? " has-back" : ""}${more.on ? " has-on" : ""}`}
        ref={strip}
        onScroll={measure}
        role="list"
        aria-label={t("site.home.photos")}
      >
        {faces.map(({ id, link }) => {
          const xref = xrefOf(id);
          const indi = ds.individuals.get(xref);
          const name = indi ? nameOf(indi) : "";
          return (
            <button key={id} type="button" role="listitem" className="site-tray-photo" title={name} onClick={() => onNavigate(xref)}>
              <img src={pathOf.get(link.photo)} alt={name} loading="lazy" onLoad={measure} />
            </button>
          );
        })}
      </div>
      {more.on && (
        <button type="button" className="site-tray-arrow site-tray-on" aria-label={t("site.home.photosOn")} onClick={() => scroll(1)}><ChevronIcon dir="right" size={18} /></button>
      )}
    </div>
  );
}
