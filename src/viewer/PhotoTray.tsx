import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { PublishedTree } from "../publish/model";
import type { PubPhotoLink } from "../publish/photos";
import { CroppedImg } from "../ui/PersonMedia";
import { useNameOf } from "../ui/SettingsContext";
import { xrefOf } from "../publish/hydrate";

/** How many faces the front page shows. */
export const TRAY_SIZE = 12;

/**
 * Each person's face for the front page: a photo of them alone where they have
 * one, and a group photo — cut to them — only when it is the one photo they
 * have. People with neither are not offered.
 */
export function trayFaces(tree: PublishedTree): { id: string; link: PubPhotoLink }[] {
  const peopleOn = new Map<string, number>();
  for (const p of tree.people) for (const l of p.photos ?? []) peopleOn.set(l.photo, (peopleOn.get(l.photo) ?? 0) + 1);
  const out: { id: string; link: PubPhotoLink }[] = [];
  for (const p of tree.people) {
    const links = p.photos ?? [];
    const alone = links.find((l) => peopleOn.get(l.photo) === 1);
    const pick = alone ?? (links.length === 1 ? links[0] : undefined);
    if (pick) out.push({ id: p.id, link: pick });
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

/** A row of faces at the top of the front page, a new choice on every visit;
 *  a face opens that person's page. */
export function PhotoTray({ tree, ds, onNavigate }: { tree: PublishedTree; ds: Dataset; onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const faces = useMemo(() => sample(trayFaces(tree), TRAY_SIZE, Math.random), [tree]);
  const pathOf = useMemo(() => new Map((tree.photos ?? []).map((p) => [p.id, p.path])), [tree]);
  if (!faces.length) return null;
  return (
    <div className="site-tray" role="list" aria-label={t("site.home.photos")}>
      {faces.map(({ id, link }) => {
        const xref = xrefOf(id);
        const indi = ds.individuals.get(xref);
        const name = indi ? nameOf(indi) : "";
        return (
          <button key={id} type="button" role="listitem" className="site-tray-face" title={name} onClick={() => onNavigate(xref)}>
            {link.crop ? (
              <CroppedImg url={pathOf.get(link.photo) ?? ""} crop={link.crop} size={88} className="site-tray-img" />
            ) : (
              <span className="site-tray-img">
                <img src={pathOf.get(link.photo)} alt="" />
              </span>
            )}
            <span className="site-tray-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
