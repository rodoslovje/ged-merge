import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import { decomposePlace, placeAddressDetail, placeCollator, placeNodeCoord } from "../gedcom/place";
import { distinctSpots } from "./placeCoords";
import { label } from "../match/relatives";
import { familySpouses, type PersonRef } from "./sources";

/**
 * Place explorer: a read-only, best-effort hierarchy of every place named in
 * the file. Each distinct `PLAC` value is decomposed (reusing
 * {@link decomposePlace}) and slotted into a country → … → locality → house
 * tree, so the place vocabulary — otherwise scattered across event records —
 * can be browsed in one place. Leaves carry the `INDI`/`FAM` records that use
 * them so the UI can navigate into Edit mode.
 */

/** Synthetic root for places with no recognizable country. */
export const UNSPECIFIED = "\0unspecified";

/** Synthetic root for standalone addresses (an `ADDR` with no sibling `PLAC`),
 * which carry no jurisdiction to slot into the country hierarchy. Reuses the
 * `UNSPECIFIED` sentinel prefix so it sorts apart from real place names. */
export const UNSPECIFIED_PLACE = `${UNSPECIFIED}-place`;

/** A record that uses a place value — a navigate target. */
export interface PlaceUse {
  /** The person(s) to display and link: one for an `INDI` record, the spouses for a `FAM`. */
  persons: PersonRef[];
  /** The record the place is actually written on — the `INDI`, or the `FAM`
   *  itself for a marriage place. Not the same thing as `persons`: a family's
   *  place is shown under its spouses but lives on neither of their records,
   *  so an edit scoped to the people would miss it entirely. */
  recordId: string;
  /** The original `PLAC` text, shown as a tooltip on the usage. */
  raw: string;
}

export interface PlaceNode {
  /** Path segment name; `UNSPECIFIED` marks the no-country bucket (UI labels it). */
  name: string;
  /** Total usages in this node's whole subtree. */
  count: number;
  children: PlaceNode[];
  /** Records whose place resolves exactly to this node's path. */
  uses: PlaceUse[];
  /** True when this node represents a street/house-number address detail rather than a jurisdiction level. */
  isAddress?: boolean;
  /** The `PLAC.MAP` coordinates the file writes for this exact path, as
   *  distinct spots with the number of mentions at each, most-used first.
   *  Absent when the path was never geocoded; more than one entry means the
   *  file contradicts itself about where this place is. */
  coords?: { coord: GeoCoord; n: number }[];
}

export interface PlaceTree {
  roots: PlaceNode[];
  /** Top-level country roots, excluding the synthetic unspecified buckets. */
  countryCount: number;
  /** Distinct place strings encountered. */
  distinctCount: number;
  /** Total place mentions across all records. */
  totalUses: number;
}

interface MutableNode {
  name: string;
  children: Map<string, MutableNode>;
  uses: PlaceUse[];
  isAddress: boolean;
  /** "lat:lon" → the coordinate and how many mentions wrote it, so a path the
   *  file geocoded inconsistently still reports its prevailing value. */
  coords: Map<string, { coord: GeoCoord; n: number }>;
}

function childNode(parent: MutableNode, name: string, isAddress: boolean): MutableNode {
  let n = parent.children.get(name);
  if (!n) {
    n = { name, children: new Map(), uses: [], isAddress, coords: new Map() };
    parent.children.set(name, n);
  } else if (!isAddress) {
    // Jurisdiction context overrides address: a segment seen as both stays non-address.
    n.isAddress = false;
  }
  return n;
}

/** A place mention: the `PLAC` text plus the `ADDR` on the same event, when present. */
interface PlaceMention {
  raw: string;
  addr?: string;
  /** The `MAP` coordinate written under this mention's `PLAC`, when present. */
  coord?: GeoCoord;
  /** True when `raw` is a standalone `ADDR` with no sibling `PLAC` — bucketed
   * under {@link UNSPECIFIED_PLACE} since it has no jurisdiction. */
  addrOnly?: boolean;
}

/**
 * Recursively collect place mentions from a subtree. A `PLAC` is paired with the
 * `ADDR` sibling under the same event node (`2 PLAC …` / `2 ADDR …`) so the
 * street address can become a deeper tree level than its place. An event that
 * has an `ADDR` but no `PLAC` still names a real location, so it is collected as
 * an `addrOnly` mention rather than dropped.
 */
function collectPlaces(node: GedNode, into: PlaceMention[]): void {
  const placs = node.children.filter((c) => c.tag === "PLAC" && c.value?.trim());
  const addr = node.children.find((c) => c.tag === "ADDR" && c.value?.trim());
  if (placs.length > 0) {
    for (const plac of placs)
      into.push({ raw: plac.value!.trim(), addr: addr?.value?.trim(), coord: placeNodeCoord(plac) });
  } else if (addr) {
    into.push({ raw: addr.value!.trim(), addrOnly: true });
  }
  for (const child of node.children) collectPlaces(child, into);
}

/** The street + number a usage sits at: the address's leading segment. */
function addressLevel(addr: string): string | undefined {
  const lead = addr.split(",")[0].trim();
  return lead.length ? lead : undefined;
}

/**
 * Map each entry in `d.jurisdiction` back to its original raw comma-segment text.
 * For most segments this is an exact match. For the country segment, `decomposePlace`
 * strips trailing parentheticals (e.g. "(FYR)"), so we do a base-stripped lookup
 * for that entry only — returning "Macedonia (FYR)" instead of "Macedonia".
 * When the country comes from a parenthetical inside another segment (e.g.
 * "Skopje (Macedonia)"), no raw segment will match and we fall back to the stripped name.
 */
function mapJurisdictionToRaw(raw: string, jurisdiction: string[], country: string | undefined): string[] {
  const rawParts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const used = new Set<number>();
  return jurisdiction.map((j) => {
    for (let i = 0; i < rawParts.length; i++) {
      if (!used.has(i) && rawParts[i] === j) { used.add(i); return rawParts[i]; }
    }
    if (country && j.toLowerCase() === country.toLowerCase()) {
      for (let i = 0; i < rawParts.length; i++) {
        if (used.has(i)) continue;
        const base = rawParts[i].replace(/(\s*\([^)]*\))+$/, "").trim();
        if (base === j) { used.add(i); return rawParts[i]; }
      }
    }
    return j;
  });
}

interface PathSegment {
  name: string;
  isAddress: boolean;
}

/** Hierarchy path for a place, country-first; no-country places go under
 *  UNSPECIFIED, and standalone addresses under UNSPECIFIED_PLACE.
 *  Each segment is tagged as jurisdiction or address so the UI can differentiate them. */
function placePath({ raw, addr, addrOnly }: PlaceMention): PathSegment[] {
  const d = decomposePlace(raw);
  // Use raw segment text (preserving parentheticals like "(FYR)") for path labels.
  const rawJurisdiction = mapJurisdictionToRaw(raw, d.jurisdiction, d.country);
  const rev = [...rawJurisdiction].reverse();
  const segments: PathSegment[] = [];
  if (addrOnly) {
    // The whole value is an ADDR with no PLAC sibling — all levels are address-type.
    segments.push({ name: UNSPECIFIED_PLACE, isAddress: false }); // synthetic bucket, not an address itself
    for (const name of rev) if (name) segments.push({ name, isAddress: true });
  } else {
    const prefix = d.country ? [] : [UNSPECIFIED];
    for (const name of [...prefix, ...rev]) if (name) segments.push({ name, isAddress: false });
  }
  // Append the house/street detail from the place, then the event's ADDR, as
  // the deepest "address" levels — skipping an ADDR that just repeats the detail.
  // A locality carrying a house number keeps that locality as its jurisdiction
  // level and hangs the full "Krupa 7" off it, so a file that numbers houses in
  // the place value browses by settlement like any other.
  const detail = placeAddressDetail(d);
  if (detail) segments.push({ name: detail, isAddress: true });
  const street = addr ? addressLevel(addr) : undefined;
  if (street && street.toLowerCase() !== detail?.toLowerCase()) segments.push({ name: street, isAddress: true });
  return segments.filter((s) => s.name.length > 0);
}

function finalize(node: MutableNode): PlaceNode {
  const children = [...node.children.values()]
    .map(finalize)
    .sort(sortNodes);
  const count = node.uses.length + children.reduce((s, c) => s + c.count, 0);
  return {
    name: node.name,
    count,
    children,
    uses: node.uses,
    isAddress: node.isAddress || undefined,
    // Rounding variants and a re-geocode a few metres off are the same spot,
    // not a contradiction — the geocoder's own rule decides which is which.
    coords: node.coords.size ? distinctSpots([...node.coords.values()]) : undefined,
  };
}

const collator = placeCollator;

/** Sort rank for the synthetic buckets: real names first, then "unspecified
 *  country", then "unspecified place" — both kept after named places. */
const bucketRank = (name: string): number =>
  name === UNSPECIFIED ? 1 : name === UNSPECIFIED_PLACE ? 2 : 0;

/** Alphabetical by name (house numbers ordered numerically), buckets last. */
function sortNodes(a: PlaceNode, b: PlaceNode): number {
  const ra = bucketRank(a.name);
  const rb = bucketRank(b.name);
  if (ra !== rb) return ra - rb;
  return collator.compare(a.name, b.name);
}

/**
 * Collect every record ID (INDI or FAM) referenced anywhere in a node's
 * subtree — the scope a place rename is applied to.
 *
 * The records that *carry* the place, not the people shown beside it. A
 * marriage place lives on the FAM, which is listed under its spouses; scoping
 * to those spouses left the family out of its own rename, so a place used only
 * by families reported "no matching records" and renaming it did nothing.
 */
export function collectNodeUseIds(node: PlaceNode): Set<string> {
  const ids = new Set<string>();
  function visit(n: PlaceNode) {
    for (const use of n.uses) ids.add(use.recordId);
    for (const child of n.children) visit(child);
  }
  visit(node);
  return ids;
}

/** Count distinct place strings across all `INDI`/`FAM` records — the same
 * keying as {@link buildPlaceTree}'s `distinctCount`, but without decomposing
 * into the hierarchy, so it's cheap enough for an always-visible header stat. */
export function countDistinctPlaces(dataset: Dataset): number {
  const distinct = new Set<string>();
  const mentions: PlaceMention[] = [];
  for (const indi of dataset.individuals.values()) collectPlaces(indi.raw, mentions);
  for (const fam of dataset.families.values()) collectPlaces(fam.raw, mentions);
  for (const m of mentions) distinct.add(m.addr ? `${m.raw} | ${m.addr}` : m.raw);
  return distinct.size;
}

export function buildPlaceTree(dataset: Dataset): PlaceTree {
  const root: MutableNode = { name: "", children: new Map(), uses: [], isAddress: false, coords: new Map() };
  const distinct = new Set<string>();
  let totalUses = 0;

  const visit = (rec: GedNode, use: Omit<PlaceUse, "raw">) => {
    const found: PlaceMention[] = [];
    collectPlaces(rec, found);
    const seenPaths = new Set<string>();
    for (const mention of found) {
      distinct.add(mention.addr ? `${mention.raw} | ${mention.addr}` : mention.raw);
      totalUses++;
      const path = placePath(mention);
      if (path.length === 0) continue;
      const pathKey = path.map((s) => s.name).join("\0");
      if (seenPaths.has(pathKey)) continue;
      seenPaths.add(pathKey);
      let node = root;
      for (const seg of path) node = childNode(node, seg.name, seg.isAddress);
      const raw = mention.addr ? `${mention.raw} — ${mention.addr}` : mention.raw;
      node.uses.push({ ...use, raw });
      // The coordinate belongs to the deepest level the mention reached: the
      // file writes one per PLAC+ADDR pair, which is exactly this node.
      if (mention.coord) {
        const ck = `${mention.coord.lat}:${mention.coord.lon}`;
        const hit = node.coords.get(ck);
        if (hit) hit.n++;
        else node.coords.set(ck, { coord: mention.coord, n: 1 });
      }
    }
  };

  for (const indi of dataset.individuals.values()) {
    visit(indi.raw, { recordId: indi.id, persons: [{ id: indi.id, label: label(indi) }] });
  }
  for (const fam of dataset.families.values()) {
    const persons = familySpouses(dataset, fam.id);
    if (persons.length === 0) continue;
    visit(fam.raw, { recordId: fam.id, persons });
  }

  const roots = [...root.children.values()].map(finalize).sort(sortNodes);
  const countryCount = roots.filter((r) => bucketRank(r.name) === 0).length;
  return { roots, countryCount, distinctCount: distinct.size, totalUses };
}
