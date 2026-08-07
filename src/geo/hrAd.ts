import { foldToken } from "../match/text";
import { isInCroatia, laea3035ToWgs84 } from "./laea";

// The Croatian address register (DGU), as this app keeps it: parsing the
// INSPIRE download into a compact per-settlement form, and answering one house
// out of it.
//
// Croatia's WFS for addresses is not public — it serves only Croatian public
// bodies — so there is no live service to ask the way the Slovenian register is
// asked (rn.ts). What the DGU does publish is a weekly INSPIRE download,
// `INSPIRE_Addresses_(AD).zip`: 85 MB that inflate to 2.6 GB of GML holding all
// 1.68 million Croatian addresses, CORS open so the browser can fetch it
// directly. So Croatia works the other way round: download once, keep it, and
// every lookup afterwards is local and instant — and works with no network at
// all.
//
// The download is four GML files. Three are small side tables the addresses
// point into by `xlink:href`, and are parsed whole:
//   - AdminUnitName.gml — 6759 naselja (4thOrder) plus the country itself
//   - ThoroughfareName.gml — 54 432 street names
//   - PostalDescriptor.gml — 900 post codes and their post offices
// The fourth, Address.gml, is the 2.6 GB one and is never held: it is read as a
// stream, one `wfs:member` at a time, into the buckets below.
//
// Data: Državna geodetska uprava, INSPIRE download service.

/** How many decimal degrees a stored coordinate is scaled by. 1e6 is ~10 cm,
 *  finer than the register's own positions and than anything written to a
 *  GEDCOM, and keeps every Croatian value inside an Int32. */
const COORD_SCALE = 1e6;

/** One address as the parser reads it, before it is bucketed. */
export interface HrAddressRow {
  /** gml:id number of the naselje this house belongs to. */
  settlementId: number;
  /** gml:id number of its ThoroughfareName. Every Croatian address has one:
   *  where a village numbers its houses directly, the register files them under
   *  a "street" named after the village itself. */
  streetId: number;
  /** gml:id number of its PostalDescriptor. */
  postId: number;
  /** House number proper (`addressNumber`). */
  number: number;
  /** Letter extension, lowercased — the "A" of "45A". "" when there is none. */
  ext: string;
  /** Second, numeric extension — the "1" of "22/1". 0 when there is none. */
  ext2: number;
  lat: number;
  lon: number;
}

/**
 * One settlement's addresses, as one IndexedDB record.
 *
 * Bucketed by settlement because that is exactly how a lookup arrives: a place
 * value names its village, so one record read answers every house in it. The
 * columns are typed arrays — 1.68 million addresses come to some 35 MB this
 * way, against several hundred as objects — and the two string tables are
 * per-bucket rather than global, so a lookup reads one record and nothing else.
 */
export interface HrAddressBucket {
  /** Store key: `HR:<settlementId>`. */
  key: string;
  id: number;
  /** The naselje's name, as the register spells it. */
  name: string;
  /** Street names this bucket's rows index into. */
  streets: string[];
  /** Post lines ("49243 Oroslavje") this bucket's rows index into. */
  posts: string[];
  st: Int32Array;
  po: Uint16Array;
  num: Int32Array;
  /** Letter extension as a code point, 0 for none — one char covers every
   *  extension the register uses (A…Ž). */
  ext: Uint16Array;
  ext2: Uint8Array;
  /** Degrees × {@link COORD_SCALE}. */
  lat: Int32Array;
  lon: Int32Array;
}

/** What is in the store, and enough to search it without reading a bucket. */
export interface HrAddressIndex {
  country: "HR";
  /** Addresses stored, across every bucket. */
  count: number;
  importedAt: number;
  /** Every naselje, with how many addresses its bucket holds. */
  settlements: { id: number; name: string; count: number }[];
  /** Every post-office name the register uses — what lets a place's parent
   *  level be told from a name the register has simply never heard of. */
  postNames: string[];
}

/** One register address resolved for the review UI. Deliberately the shape
 *  {@link import("./rn").RnResult} has, so both registers answer alike. */
export interface HrAddressHit {
  coord: { lat: number; lon: number };
  /** "Brežna ulica 33", or "Bapča 22" where the village numbers directly. */
  address: string;
  /** "49243 Oroslavje". */
  post?: string;
  label: string;
  settlement: string;
  number: number;
  suffix?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `gml:id="AdminUnitName.5000585"` — the numeric half is the id used by the
 *  `xlink:href="#AdminUnitName.5000585"` references on an address. */
const GML_ID = /gml:id="[A-Za-z]+\.(\d+)"/;
/** The first spelling of a feature's name. */
const GN_TEXT = /<gn:text>([^<]*)<\/gn:text>/;

/** Split a GML feature collection into its `wfs:member` bodies. */
function members(text: string): string[] {
  return text.split("</wfs:member>");
}

/**
 * The naselje names of AdminUnitName.gml, by gml:id.
 *
 * Only 4th-order units — the register's one other entry is Croatia itself, and
 * every address references *both*, so which of its two `AdminUnitName` links is
 * the settlement is decided by which one this map holds. That is deliberately a
 * lookup and not the link's position: the ids are regenerated weekly.
 */
export function parseAdminUnitNames(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const member of members(text)) {
    if (!member.includes("AdministrativeHierarchyLevel/4thOrder")) continue;
    const id = GML_ID.exec(member);
    const name = GN_TEXT.exec(member);
    if (id && name?.[1]) out.set(Number(id[1]), name[1]);
  }
  return out;
}

/** The street names of ThoroughfareName.gml, by gml:id. */
export function parseThoroughfareNames(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const member of members(text)) {
    if (!member.includes("<ad:ThoroughfareName ")) continue;
    const id = GML_ID.exec(member);
    const name = GN_TEXT.exec(member);
    if (id && name?.[1]) out.set(Number(id[1]), name[1]);
  }
  return out;
}

const POST_CODE = /<ad:postCode>([^<]*)<\/ad:postCode>/;

/** The post lines of PostalDescriptor.gml ("49243 Oroslavje"), by gml:id, with
 *  the post-office name kept apart — it is what a place value names as the
 *  level above the village, so it is what scoping compares against. */
export function parsePostalDescriptors(text: string): Map<number, { line: string; name: string }> {
  const out = new Map<number, { line: string; name: string }>();
  for (const member of members(text)) {
    if (!member.includes("<ad:PostalDescriptor ")) continue;
    const id = GML_ID.exec(member);
    if (!id) continue;
    const name = GN_TEXT.exec(member)?.[1]?.trim() ?? "";
    const code = POST_CODE.exec(member)?.[1]?.trim() ?? "";
    const line = code && name ? `${code} ${name}` : code || name;
    if (line) out.set(Number(id[1]), { line, name });
  }
  return out;
}

const POS = /<gml:pos[^>]*>([-\d.eE+]+)\s+([-\d.eE+]+)<\/gml:pos>/;
const HREF = /xlink:href="#([A-Za-z]+)\.(\d+)"/g;
const DESIGNATOR = /<ad:designator>([^<]*)<\/ad:designator><ad:type xlink:href="[^"]*\/([A-Za-z0-9]+)"/g;

/**
 * One `ad:Address` member, or undefined when it is not one this app can place.
 *
 * `settlements` decides which of the member's two AdminUnitName links is the
 * naselje (see {@link parseAdminUnitNames}). Note the axis order: the register
 * writes `gml:pos` in the CRS's own order, northing before easting, which is
 * the opposite of the way every projection in this app takes its arguments.
 */
export function parseAddressMember(member: string, settlements: ReadonlyMap<number, string>): HrAddressRow | undefined {
  const pos = POS.exec(member);
  if (!pos) return undefined;
  const coord = laea3035ToWgs84(Number(pos[2]), Number(pos[1]));
  // A row whose position will not project, or projects outside the country the
  // register covers, is a broken row — dropped rather than stored as a house in
  // the sea.
  if (!isInCroatia(coord)) return undefined;

  let settlementId = 0;
  let streetId = 0;
  let postId = 0;
  HREF.lastIndex = 0;
  for (let m = HREF.exec(member); m; m = HREF.exec(member)) {
    const id = Number(m[2]);
    if (m[1] === "ThoroughfareName") streetId = id;
    else if (m[1] === "PostalDescriptor") postId = id;
    else if (m[1] === "AdminUnitName" && settlements.has(id)) settlementId = id;
  }
  if (!settlementId) return undefined;

  let number = 0;
  let ext = "";
  let ext2 = 0;
  DESIGNATOR.lastIndex = 0;
  for (let m = DESIGNATOR.exec(member); m; m = DESIGNATOR.exec(member)) {
    const value = m[1].trim();
    if (m[2] === "addressNumber") number = Number(value);
    // Both extensions are stored in one small column each — a letter as a code
    // point, the second as a byte — so anything that would not fit is dropped
    // rather than silently wrapped into a different house. The register's own
    // values are a single Latin letter and a number under 50.
    else if (m[2] === "addressNumberExtension") {
      const letter = value.toLowerCase().slice(0, 1);
      ext = (letter.codePointAt(0) ?? 0) <= 0xffff ? letter : "";
    } else if (m[2] === "addressNumber2ndExtension") {
      const second = Number(value);
      ext2 = Number.isInteger(second) && second > 0 && second <= 255 ? second : 0;
    }
  }
  if (!Number.isFinite(number) || number <= 0) return undefined;

  return {
    settlementId,
    streetId,
    postId,
    number,
    ext,
    ext2,
    lat: coord!.lat,
    lon: coord!.lon,
  };
}

/**
 * Collect parsed rows into per-settlement buckets.
 *
 * Rows arrive in the register's own order, which is roughly but not reliably
 * grouped by settlement, so each bucket grows as its rows turn up. Held as
 * plain number arrays while collecting and packed into typed arrays only at
 * {@link AddressCollector.buckets} — the whole register is some 100 MB this
 * way, which a worker can carry, and 35 MB once packed.
 */
export class AddressCollector {
  private readonly groups = new Map<
    number,
    { streets: string[]; streetIds: Map<number, number>; posts: string[]; postIds: Map<number, number>; rows: number[] }
  >();
  private total = 0;

  constructor(
    private readonly settlements: ReadonlyMap<number, string>,
    private readonly streets: ReadonlyMap<number, string>,
    private readonly posts: ReadonlyMap<number, { line: string; name: string }>,
  ) {}

  add(row: HrAddressRow): void {
    let g = this.groups.get(row.settlementId);
    if (!g) {
      g = { streets: [], streetIds: new Map(), posts: [], postIds: new Map(), rows: [] };
      this.groups.set(row.settlementId, g);
    }
    // A name unknown to its side table becomes an empty slot rather than a
    // dropped address: the house is still where it is, it just cannot say what
    // street it is on.
    const streetIdx = intern(g.streetIds, g.streets, row.streetId, this.streets.get(row.streetId) ?? "");
    const postIdx = intern(g.postIds, g.posts, row.postId, this.posts.get(row.postId)?.line ?? "");
    g.rows.push(streetIdx, postIdx, row.number, row.ext ? row.ext.codePointAt(0)! : 0, row.ext2,
      Math.round(row.lat * COORD_SCALE), Math.round(row.lon * COORD_SCALE));
    this.total++;
  }

  get count(): number {
    return this.total;
  }

  /** The buckets, packed. */
  buckets(): HrAddressBucket[] {
    const out: HrAddressBucket[] = [];
    for (const [id, g] of this.groups) {
      const n = g.rows.length / FIELDS;
      const bucket: HrAddressBucket = {
        key: bucketKey(id),
        id,
        name: this.settlements.get(id) ?? "",
        streets: g.streets,
        posts: g.posts,
        st: new Int32Array(n),
        po: new Uint16Array(n),
        num: new Int32Array(n),
        ext: new Uint16Array(n),
        ext2: new Uint8Array(n),
        lat: new Int32Array(n),
        lon: new Int32Array(n),
      };
      for (let i = 0; i < n; i++) {
        const at = i * FIELDS;
        bucket.st[i] = g.rows[at];
        bucket.po[i] = g.rows[at + 1];
        bucket.num[i] = g.rows[at + 2];
        bucket.ext[i] = g.rows[at + 3];
        bucket.ext2[i] = g.rows[at + 4];
        bucket.lat[i] = g.rows[at + 5];
        bucket.lon[i] = g.rows[at + 6];
      }
      out.push(bucket);
    }
    return out;
  }

  /** The index record describing what {@link buckets} holds. */
  index(importedAt: number): HrAddressIndex {
    const settlements = [...this.groups].map(([id, g]) => ({
      id,
      name: this.settlements.get(id) ?? "",
      count: g.rows.length / FIELDS,
    }));
    const postNames = [...new Set([...this.posts.values()].map((p) => p.name).filter(Boolean))];
    return { country: "HR", count: this.total, importedAt, settlements, postNames };
  }
}

/** Values kept per address row while collecting. */
const FIELDS = 7;

/** The bucket store key for a settlement id. */
export function bucketKey(id: number): string {
  return `HR:${id}`;
}

/** Position of `id`'s value in a per-bucket string table, appending it once. */
function intern(seen: Map<number, number>, table: string[], id: number, value: string): number {
  let at = seen.get(id);
  if (at === undefined) {
    at = table.length;
    table.push(value);
    seen.set(id, at);
  }
  return at;
}

// ---------------------------------------------------------------------------
// Searching one settlement
// ---------------------------------------------------------------------------

/** What a lookup asks one bucket for. */
export interface HrBucketQuery {
  number: number;
  /** Letter suffix, lowercased. */
  suffix?: string;
  /** The name the number hangs off, when the file names one that is not the
   *  settlement itself. */
  street?: string;
}

/** Read one row out of a bucket. */
function hitAt(bucket: HrAddressBucket, i: number): HrAddressHit {
  const street = bucket.streets[bucket.st[i]] ?? "";
  const post = bucket.posts[bucket.po[i]] ?? "";
  const suffix = bucket.ext[i] ? String.fromCodePoint(bucket.ext[i]) : "";
  // The register's own two-part number: "45a", and "22/1" for a subdivision.
  const written = `${bucket.num[i]}${suffix}${bucket.ext2[i] ? `/${bucket.ext2[i]}` : ""}`;
  // Village numbering files a house under a "street" named after the village;
  // written out that reads as the address it really is ("Bapča 22").
  const address = `${street || bucket.name} ${written}`.trim();
  const parts = [address];
  if (street && foldToken(street) !== foldToken(bucket.name)) parts.push(bucket.name);
  if (post) parts.push(post);
  return {
    coord: { lat: bucket.lat[i] / COORD_SCALE, lon: bucket.lon[i] / COORD_SCALE },
    address,
    ...(post ? { post } : {}),
    label: parts.join(", "),
    settlement: bucket.name,
    number: bucket.num[i],
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * The houses one bucket holds for a query, narrowest reading first.
 *
 * The same widening ladder the Slovenian register is walked with, done locally:
 *   1. the street as written, matched as a prefix — files abbreviate ("Ilica"
 *      for "Ilica ulica"), and a street the register renamed since simply finds
 *      nothing here and falls through;
 *   2. with no street named, the houses the village numbers directly — the rows
 *      whose "street" is the settlement's own name;
 *   3. failing either, every house in the settlement carrying that number, which
 *      is honest: the file does not say which street, so neither can we, and the
 *      review UI offers them as a choice.
 * The letter suffix narrows within whichever rung answered, and is dropped when
 * it narrows to nothing — a file recording "45a" where the register has a plain
 * 45 is the common case, not a miss.
 */
export function searchBucket(bucket: HrAddressBucket, query: HrBucketQuery): HrAddressHit[] {
  const rows: number[] = [];
  for (let i = 0; i < bucket.num.length; i++) if (bucket.num[i] === query.number) rows.push(i);
  if (!rows.length) return [];

  const streetOf = (i: number) => foldToken(bucket.streets[bucket.st[i]] ?? "");
  const settlement = foldToken(bucket.name);
  let scoped: number[];
  if (query.street) {
    const wanted = foldToken(query.street);
    scoped = rows.filter((i) => {
      const s = streetOf(i);
      return !!s && (s.startsWith(wanted) || wanted.startsWith(s));
    });
  } else {
    scoped = rows.filter((i) => streetOf(i) === settlement);
  }
  if (!scoped.length) scoped = rows;

  const suffix = query.suffix?.toLowerCase();
  const exact = scoped.filter((i) => {
    const own = bucket.ext[i] ? String.fromCodePoint(bucket.ext[i]).toLowerCase() : "";
    return suffix ? own === suffix : !own && !bucket.ext2[i];
  });
  return (exact.length ? exact : scoped).map((i) => hitAt(bucket, i));
}

/**
 * Narrow hits to the place's own parent level, to nothing if need be.
 *
 * Croatia reuses settlement names as freely as Slovenia does — 313 of the 6358
 * names are borne by more than one village — so a name alone can answer with a
 * house 200 km away. The register's addresses name no municipality, but they do
 * name a post office, and a Croatian place value's second level is very often
 * exactly that ("Andraševec, Oroslavje").
 *
 * The two ways of finding nothing are told apart the way the Slovenian ladder
 * tells them apart, only offline: a parent the register knows as a post office
 * or a settlement somewhere *contradicts* these hits, and they go; a parent it
 * has never heard of — a županija, a parish — contradicts nothing, and they
 * stand.
 */
export function scopeToParents(
  hits: readonly HrAddressHit[],
  parents: readonly string[] | undefined,
  known: { postNames: ReadonlySet<string>; settlementNames: ReadonlySet<string> },
): HrAddressHit[] {
  if (!parents?.length || !hits.length) return [...hits];
  const wanted = new Set(parents.map(foldToken).filter(Boolean));
  if (!wanted.size) return [...hits];
  const kept = hits.filter(
    (h) => wanted.has(foldToken(postNameOf(h))) || wanted.has(foldToken(h.settlement)),
  );
  if (kept.length) return kept;
  for (const parent of wanted) {
    if (known.postNames.has(parent) || known.settlementNames.has(parent)) return [];
  }
  return [...hits];
}

/** The post-office half of a "49243 Oroslavje" line. */
function postNameOf(hit: HrAddressHit): string {
  return hit.post?.replace(/^\d+\s+/, "") ?? "";
}
