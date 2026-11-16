import type { Dataset, GedNode } from "../gedcom/types";
import type { CropRegion } from "../gedcom/source";
import { collectMediaRefs, type MediaRef } from "../gedcom/media";
import { mediaKindOf } from "../ui/mediaPath";
import type { PublishedTree } from "./model";

/**
 * The family website's photos: which go in, and on whose page.
 *
 * A photo is published only when nobody on it is hidden. Every link to it in
 * the whole file is weighed — the people tagged on it, the couple a family
 * photo belongs to — and one hidden person (living or recently dead while the
 * living are withheld, flagged private, or not checked at all) keeps the photo
 * out, however many of the others are long dead. A photo flagged private stays
 * out too, and only local image files count (not PDFs, not web links).
 *
 * The author also says, folder by folder of the media folder, where a photo
 * goes: left out, on the person pages, or there and in the front page's strip
 * too (see {@link PhotoUse}).
 *
 * In the website's ZIP a photo sits at `photos/<id>.<ext>`; `sources` says
 * which file of the author's media folder each one is read from.
 */

/** Where a folder's photos go: nowhere, the person pages, or those and the
 *  front page's strip (the default). */
export type PhotoUse = "out" | "pages" | "tray";
export const PHOTO_USES: PhotoUse[] = ["out", "pages", "tray"];

/** The folder a `FILE` sits in, `/`-separated ("" for the media folder itself). */
export function folderOf(file: string): string {
  const path = file.replace(/\\/g, "/").replace(/^(\.\/)+|^\/+/, "");
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** A `FILE` that is a web address, not a file of the media folder. */
const isWebLink = (file: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(file);

/** Where a photo goes: its folder's choice, else the nearest folder's above
 *  it, else the strip too. "" is the files directly in the media folder only,
 *  not a default for every folder. */
export function photoUseOf(folders: Readonly<Record<string, PhotoUse>>, file: string): PhotoUse {
  let folder = folderOf(file);
  for (;;) {
    const use = folders[folder];
    if (use && PHOTO_USES.includes(use)) return use;
    const at = folder.lastIndexOf("/");
    if (at < 0) return "tray";
    folder = folder.slice(0, at);
  }
}

export interface PubPhoto {
  id: string;
  /** The photo's path in the website's ZIP (`photos/o1x2.jpg`). */
  path: string;
  /** Its folder keeps it out of the front page's strip. */
  tray?: false;
  title?: string;
  date?: string;
  place?: string;
  description?: string;
}

/** A person's link to a photo, with the region that shows them on it. */
export interface PubPhotoLink {
  photo: string;
  crop?: CropRegion;
}

export interface PhotoPlan {
  photos: PubPhoto[];
  /** Each published person's photos, by their dataset id, in their order. */
  links: Map<string, PubPhotoLink[]>;
  /** Each photo's ZIP path → the `FILE` it is read from. */
  sources: Map<string, string>;
  /** Photos left out: someone hidden is on them, or they are private. */
  withheld: number;
}

interface Owner {
  /** The people the link stands for: the person, or a family's couple. */
  people: string[];
  /** A family's link, which no single person's crop belongs to. */
  family?: string;
  crop?: CropRegion;
}

interface Candidate {
  ref: MediaRef;
  owners: Owner[];
  private: boolean;
}

/** The identity of a photo: its shared record, or its file for an inline one. */
const keyOf = (ref: MediaRef) => ref.xref ?? `file:${ref.file}`;

/** The photos of the people and families, by folder: how many each folder
 *  holds — for the author's choice per folder. Web links are not counted. */
export function photoFolderCounts(ds: Dataset): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const visit = (raw: GedNode) => {
    for (const ref of collectMediaRefs(raw, ds.records)) {
      if (mediaKindOf(ref.file) !== "image" || isWebLink(ref.file)) continue;
      const key = keyOf(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const folder = folderOf(ref.file);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  };
  for (const indi of ds.individuals.values()) visit(indi.raw);
  for (const fam of ds.families.values()) visit(fam.raw);
  return counts;
}

/** A short, stable id: FNV-1a of the key, in base 36. */
function photoId(key: string, taken: Set<string>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const base = "o" + (h >>> 0).toString(36);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  taken.add(id);
  return id;
}

const extensionOf = (file: string) => file.match(/\.([a-z0-9]{1,5})$/i)?.[1].toLowerCase() ?? "jpg";

/**
 * Plan the photos. `published(id)` says a person is on the site with their
 * details (only they get a gallery); `hidden(id)` says a person must not be
 * seen on any photo; `folders` where each folder's photos go. `yieldEvery`
 * paces a stepped caller.
 */
export function* planSitePhotos(
  ds: Dataset,
  published: (id: string) => boolean,
  hidden: (id: string) => boolean,
  folders: Readonly<Record<string, PhotoUse>> = {},
  yieldEvery = 1_000,
): Generator<void, PhotoPlan, void> {
  const candidates = new Map<string, Candidate>();
  // Each person's photos in their own order — their record's (primary first),
  // then their families' — with the region that shows them.
  const order = new Map<string, { key: string; crop?: CropRegion }[]>();
  let n = 0;
  const visit = (raw: GedNode, owner: (ref: MediaRef) => Owner) => {
    for (const ref of collectMediaRefs(raw, ds.records)) {
      if (mediaKindOf(ref.file) !== "image" || isWebLink(ref.file)) continue;
      if (photoUseOf(folders, ref.file) === "out") continue;
      const key = keyOf(ref);
      let c = candidates.get(key);
      if (!c) candidates.set(key, (c = { ref, owners: [], private: false }));
      if (ref.private) c.private = true;
      const o = owner(ref);
      c.owners.push(o);
      for (const person of o.people) {
        const list = order.get(person) ?? [];
        const at = list.findIndex((l) => l.key === key);
        // One entry per photo and person: their own cropped link wins.
        if (at < 0) list.push(o.crop ? { key, crop: o.crop } : { key });
        else if (!list[at].crop && o.crop) list[at] = { key, crop: o.crop };
        order.set(person, list);
      }
    }
  };
  for (const indi of ds.individuals.values()) {
    if (++n % yieldEvery === 0) yield;
    visit(indi.raw, (ref) => ({ people: [indi.id], crop: ref.crop }));
  }
  for (const fam of ds.families.values()) {
    if (++n % yieldEvery === 0) yield;
    const couple = [fam.husband, fam.wife].filter((s): s is string => !!s);
    // A private family's photo is as private as the family.
    visit(fam.raw, () => ({ people: couple, family: fam.private ? "private" : fam.id }));
  }

  const plan: PhotoPlan = { photos: [], links: new Map(), sources: new Map(), withheld: 0 };
  const taken = new Set<string>();
  const idOf = new Map<string, string>();
  for (const [key, c] of candidates) {
    const blocked = c.private || c.owners.some((o) => o.family === "private" || o.people.some(hidden));
    if (blocked) {
      plan.withheld++;
      continue;
    }
    const id = photoId(key, taken);
    const path = `photos/${id}.${extensionOf(c.ref.file)}`;
    const photo: PubPhoto = { id, path };
    if (photoUseOf(folders, c.ref.file) === "pages") photo.tray = false;
    if (c.ref.title) photo.title = c.ref.title;
    if (c.ref.date) photo.date = c.ref.date;
    if (c.ref.place) photo.place = c.ref.place;
    if (c.ref.description) photo.description = c.ref.description;
    plan.photos.push(photo);
    plan.sources.set(path, c.ref.file);
    idOf.set(key, id);
  }
  for (const [person, list] of order) {
    if (!published(person)) continue;
    const links: PubPhotoLink[] = [];
    for (const { key, crop } of list) {
      const id = idOf.get(key);
      if (id) links.push(crop ? { photo: id, crop } : { photo: id });
    }
    if (links.length) plan.links.set(person, links);
  }
  return plan;
}

/** The site without the photos at these ZIP paths — ones the media folder did
 *  not have — and without every link to them. */
export function withoutPhotos(tree: PublishedTree, paths: ReadonlySet<string>): PublishedTree {
  const gone = new Set((tree.photos ?? []).filter((p) => paths.has(p.path)).map((p) => p.id));
  if (!gone.size) return tree;
  const photos = tree.photos!.filter((p) => !gone.has(p.id));
  return {
    ...tree,
    ...(photos.length ? { photos } : { photos: undefined }),
    people: tree.people.map((p) => {
      if (!p.photos?.some((l) => gone.has(l.photo))) return p;
      const left = p.photos.filter((l) => !gone.has(l.photo));
      const { photos: _drop, ...rest } = p;
      return left.length ? { ...rest, photos: left } : rest;
    }),
  };
}
