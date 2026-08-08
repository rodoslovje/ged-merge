import { foldToken } from "../match/text";

// A downloaded national address register, as this app keeps and reads one.
//
// Two countries publish their houses in bulk, and both are kept in the same
// shape here — the parsing differs (hrAd.ts, siAd.ts), everything after it does
// not. What each register gives per house is the same handful of facts: the
// settlement it belongs to, the street it hangs off (or none, where a village
// numbers its houses directly), its number, its post office, and its position.
//
// Storage is one record per settlement, because that is exactly how a lookup
// arrives: a place value names its village, so one read answers every house in
// it. Inside a bucket the columns are typed arrays and the two string tables
// are per-bucket, so a lookup touches one record and nothing else, and the
// whole of Croatia comes to 34.5 MB rather than several hundred as objects.

/** Which country's register — the prefix of every key it stores under. */
export type RegisterCountry = "SI" | "HR";

/** How many decimal degrees a stored coordinate is scaled by. 1e6 is ~10 cm,
 *  finer than any register's own positions or anything written to a GEDCOM, and
 *  keeps every European value inside an Int32. */
const COORD_SCALE = 1e6;

/** One address as a parser reads it, with every name already resolved. */
export interface AddressRow {
  /** Stable id of the settlement this house belongs to — whatever the register
   *  calls it. Two villages of one name must not share a bucket, so this is an
   *  id and never the name. Kept as a string: Slovenia's run past the largest
   *  integer a JS number holds exactly. */
  settlementId: string;
  settlement: string;
  /** The municipality the register files the settlement under, where it says —
   *  Slovenia's občina. Croatia's addresses name none. */
  municipality?: string;
  /** "" where the register files no street: the house hangs off the settlement
   *  (Slovenia), or off a "street" named after it (Croatia). */
  street: string;
  /** Post code and office as one line, "8341 Adlešiči". "" when unknown. */
  post: string;
  number: number;
  /** Letter extension, lowercased — the "b" of "69 b". "" when there is none. */
  ext: string;
  /** Second, numeric extension — the "1" of "22/1". 0 when there is none. */
  ext2: number;
  lat: number;
  lon: number;
}

/** One settlement's addresses, as one IndexedDB record. */
export interface AddressBucket {
  /** Store key: `<country>:<settlementId>`. */
  key: string;
  /** Optional because a bucket stored by the first release of this store — when
   *  Croatia was the only register — carries no country. Nothing reads it; the
   *  key already says which country a bucket is, and re-downloading 85 MB to
   *  add a field nothing asks for would be absurd. */
  country?: RegisterCountry;
  name: string;
  municipality?: string;
  /** Street names this bucket's rows index into. */
  streets: string[];
  /** Post lines this bucket's rows index into. */
  posts: string[];
  st: Int32Array;
  po: Uint16Array;
  num: Int32Array;
  /** Letter extension as a code point, 0 for none. */
  ext: Uint16Array;
  ext2: Uint8Array;
  /** Degrees × {@link COORD_SCALE}. */
  lat: Int32Array;
  lon: Int32Array;
}

/** What is in the store, and enough to search it without reading a bucket. */
export interface AddressIndex {
  country: RegisterCountry;
  /** Addresses stored, across every bucket. */
  count: number;
  importedAt: number;
  /** Every settlement, with how many addresses its bucket holds. */
  settlements: { id: string; name: string; count: number }[];
  /** Every name the register knows as a level *above* a settlement — post
   *  offices, and municipalities where it files them. What lets a place's
   *  parent level be told from a name the register has never heard of. */
  parentNames: string[];
}

/** One register address resolved for the review UI. Deliberately the shape
 *  {@link import("./rn").RnResult} has, so both registers answer alike. */
export interface AddressHit {
  coord: { lat: number; lon: number };
  /** "Brežna ulica 33", or "Bapča 22" where the village numbers directly. */
  address: string;
  /** The street alone, as the register spells it. "" where it files none —
   *  which is how Slovenia records a village that numbers its houses directly,
   *  Croatia naming the "street" after the village instead. Kept apart from
   *  {@link address} because the compliance check compares it with the street
   *  the file writes, and only that half. */
  street: string;
  post?: string;
  label: string;
  settlement: string;
  municipality?: string;
  number: number;
  suffix?: string;
}

/** The bucket store key for one settlement. */
export function bucketKey(country: RegisterCountry, id: string): string {
  return `${country}:${id}`;
}

/**
 * A stored index read back, whatever version wrote it.
 *
 * The first release of this store held Croatia alone, and called the names
 * above a settlement `postNames` — post offices were all it had, Croatia's
 * addresses naming no municipality. Slovenia's do, so the field became
 * `parentNames`, and a register stored before that came back with the new name
 * undefined and every lookup throwing.
 *
 * Read leniently rather than migrated, because the alternative is asking for
 * an 85 MB download again over a renamed field. The settlement ids are read
 * the same way: they were numbers while Croatia's were small enough to be, and
 * became strings for Slovenia's, which run past the largest integer a JS number
 * holds exactly — both spell the same store key.
 */
export function readStoredIndex(raw: unknown): AddressIndex | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const index = raw as Partial<AddressIndex> & { postNames?: string[] };
  if (!index.country || !Array.isArray(index.settlements)) return undefined;
  return {
    country: index.country,
    count: index.count ?? 0,
    importedAt: index.importedAt ?? 0,
    settlements: index.settlements.map((s) => ({ id: String(s.id), name: s.name, count: s.count })),
    parentNames: index.parentNames ?? index.postNames ?? [],
  };
}

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

/** Values kept per address row while collecting. */
const FIELDS = 7;

/**
 * Collect parsed rows into per-settlement buckets.
 *
 * Rows arrive in the register's own order, which is roughly but not reliably
 * grouped by settlement, so each bucket grows as its rows turn up. Held as
 * plain number arrays while collecting and packed into typed arrays only at
 * {@link buckets} — Croatia's 1.68 million come to some 100 MB that way, which
 * a worker can carry, and 34.5 MB once packed.
 */
export class AddressCollector {
  private readonly groups = new Map<
    string,
    {
      name: string;
      municipality?: string;
      streets: string[];
      streetAt: Map<string, number>;
      posts: string[];
      postAt: Map<string, number>;
      rows: number[];
    }
  >();
  private readonly parents = new Set<string>();
  private total = 0;

  constructor(private readonly country: RegisterCountry) {}

  add(row: AddressRow): void {
    let g = this.groups.get(row.settlementId);
    if (!g) {
      g = {
        name: row.settlement,
        ...(row.municipality ? { municipality: row.municipality } : {}),
        streets: [],
        streetAt: new Map(),
        posts: [],
        postAt: new Map(),
        rows: [],
      };
      this.groups.set(row.settlementId, g);
    }
    if (row.municipality) this.parents.add(row.municipality);
    if (row.post) this.parents.add(postNameOf(row.post));
    g.rows.push(
      intern(g.streetAt, g.streets, row.street),
      intern(g.postAt, g.posts, row.post),
      row.number,
      row.ext ? (row.ext.codePointAt(0) ?? 0) : 0,
      row.ext2,
      Math.round(row.lat * COORD_SCALE),
      Math.round(row.lon * COORD_SCALE),
    );
    this.total++;
  }

  get count(): number {
    return this.total;
  }

  /** The buckets, packed. */
  buckets(): AddressBucket[] {
    const out: AddressBucket[] = [];
    for (const [id, g] of this.groups) {
      const n = g.rows.length / FIELDS;
      const bucket: AddressBucket = {
        key: bucketKey(this.country, id),
        country: this.country,
        name: g.name,
        ...(g.municipality ? { municipality: g.municipality } : {}),
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
  index(importedAt: number): AddressIndex {
    return {
      country: this.country,
      count: this.total,
      importedAt,
      settlements: [...this.groups].map(([id, g]) => ({ id, name: g.name, count: g.rows.length / FIELDS })),
      parentNames: [...this.parents].filter(Boolean),
    };
  }
}

/** Position of a value in a per-bucket string table, appending it once. */
function intern(seen: Map<string, number>, table: string[], value: string): number {
  let at = seen.get(value);
  if (at === undefined) {
    at = table.length;
    table.push(value);
    seen.set(value, at);
  }
  return at;
}

/** The post-office half of an "8341 Adlešiči" line. */
function postNameOf(post: string): string {
  return post.replace(/^\d+\s+/, "");
}

// ---------------------------------------------------------------------------
// Searching one settlement
// ---------------------------------------------------------------------------

/** What a lookup asks one bucket for. */
export interface BucketQuery {
  number: number;
  /** Letter suffix, lowercased. */
  suffix?: string;
  /** The name the number hangs off, when the file names one that is not the
   *  settlement itself. */
  street?: string;
}

/**
 * The street-type words an address is built with, spelt out and abbreviated,
 * in both countries' vocabularies. They carry no identity — the street is the
 * *name* beside them — and which form is written is a house style, not a fact
 * about the street: the register holds "Senjsko" where a file writes "Ul.
 * Senjsko", and "Ulica hrvatskih branitelja" where a file writes "Ul.
 * hrvatskih branitelja".
 *
 * Recognized only as whole tokens, with the dot where the abbreviation carries
 * one, so a street actually *named* after one of these words is untouched.
 */
const STREET_TYPE_WORDS = new Set([
  "ulica", "ul", "ul.", "cesta", "c.", "trg", "put", "prilaz", "odvojak",
  "setaliste", "set.", "obala", "aleja", "poljana", "dvor", "stube", "naselje",
  "park", "nabrezje", "drevored",
]);

/**
 * A street name reduced to the words that identify it — its type words dropped,
 * so the file's form and the register's compare as the same street.
 *
 * Empty when the name is nothing but type words ("Trg", "Obala" are real street
 * names in their own right); the caller then compares the names as written,
 * which is the only honest reading left.
 */
export function streetKey(name: string): string {
  return foldToken(name)
    .split(/\s+/)
    .filter((w) => w && !STREET_TYPE_WORDS.has(w))
    .join(" ");
}

/** Whether two street names name the same street — either as written or by the
 *  words that identify them, and in either direction, since either side may be
 *  the abbreviated one ("Ilica" for the register's "Ilica ulica").
 *
 *  Exported because this is also what tells a register answer that is *about*
 *  the written street from one that merely shares its house number — see
 *  `addressCheck.ts`. `foldedWritten` is a parameter only so a scan over a whole
 *  bucket folds the written name once. */
export function sameStreet(written: string, registerName: string, foldedWritten = foldToken(written)): boolean {
  if (!registerName) return false;
  const folded = foldToken(registerName);
  if (folded.startsWith(foldedWritten) || foldedWritten.startsWith(folded)) return true;
  const a = streetKey(written);
  const b = streetKey(registerName);
  return !!a && !!b && (b.startsWith(a) || a.startsWith(b));
}

/** Read one row out of a bucket. */
function hitAt(bucket: AddressBucket, i: number): AddressHit {
  const street = bucket.streets[bucket.st[i]] ?? "";
  const post = bucket.posts[bucket.po[i]] ?? "";
  const suffix = bucket.ext[i] ? String.fromCodePoint(bucket.ext[i]) : "";
  // The register's own two-part number: "45a", and "22/1" for a subdivision.
  const written = `${bucket.num[i]}${suffix}${bucket.ext2[i] ? `/${bucket.ext2[i]}` : ""}`;
  // Village numbering hangs the number off the settlement — written out that
  // reads as the address it really is ("Bapča 22").
  const address = `${street || bucket.name} ${written}`.trim();
  const parts = [address];
  if (street && foldToken(street) !== foldToken(bucket.name)) parts.push(bucket.name);
  if (post) parts.push(post);
  return {
    coord: { lat: bucket.lat[i] / COORD_SCALE, lon: bucket.lon[i] / COORD_SCALE },
    address,
    street,
    ...(post ? { post } : {}),
    label: parts.join(", "),
    settlement: bucket.name,
    ...(bucket.municipality ? { municipality: bucket.municipality } : {}),
    number: bucket.num[i],
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * The houses one bucket holds for a query, narrowest reading first.
 *
 * The same widening ladder the online GURS lookup walks, done locally:
 *   1. the street as written, matched as a prefix and again on the words that
 *      identify it ({@link streetKey}) — files abbreviate ("Ilica" for "Ilica
 *      ulica") and write the type word where the register leaves it out ("Ul.
 *      Senjsko" for "Senjsko") — while a street the register renamed since
 *      simply finds nothing here and falls through;
 *   2. with no street named, the houses the village numbers directly — the rows
 *      the register files under no street at all, or under one named after the
 *      settlement, which is how the two countries each record them;
 *   3. failing either, every house in the settlement carrying that number, which
 *      is honest: the file does not say which street, so neither can we, and the
 *      review UI offers them as a choice.
 * The letter suffix narrows within whichever rung answered, and is dropped when
 * it narrows to nothing — a file recording "45a" where the register has a plain
 * 45 is the common case, not a miss.
 */
export function searchBucket(bucket: AddressBucket, query: BucketQuery): AddressHit[] {
  const rows: number[] = [];
  for (let i = 0; i < bucket.num.length; i++) if (bucket.num[i] === query.number) rows.push(i);
  if (!rows.length) return [];

  const streetOf = (i: number) => bucket.streets[bucket.st[i]] ?? "";
  const settlement = foldToken(bucket.name);
  let scoped: number[];
  if (query.street) {
    const wanted = foldToken(query.street);
    scoped = rows.filter((i) => sameStreet(query.street!, streetOf(i), wanted));
  } else {
    scoped = rows.filter((i) => {
      const s = foldToken(streetOf(i));
      return !s || s === settlement;
    });
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
 * Both countries reuse settlement names freely — 313 of Croatia's 6358 names
 * are borne by more than one village, and Slovenia has a Stražišče in each of
 * three municipalities — so a name alone can answer with a house 200 km away.
 * What a place value names above its village is matched against whatever the
 * register files the house under: the municipality where it records one
 * (Slovenia's občina), and the post office either way, which is very often
 * exactly what a place value's second level is.
 *
 * The two ways of finding nothing are told apart the way the online ladder
 * tells them apart, only offline: a parent the register knows as a municipality,
 * a post office or a settlement somewhere *contradicts* these hits, and they go;
 * one it has never heard of — a region, a parish — contradicts nothing, and they
 * stand.
 */
export function scopeToParents(
  hits: readonly AddressHit[],
  parents: readonly string[] | undefined,
  known: { parentNames: ReadonlySet<string>; settlementNames: ReadonlySet<string> },
): AddressHit[] {
  if (!parents?.length || !hits.length) return [...hits];
  const wanted = new Set(parents.map(foldToken).filter(Boolean));
  if (!wanted.size) return [...hits];
  const kept = hits.filter(
    (h) =>
      (h.municipality && wanted.has(foldToken(h.municipality))) ||
      wanted.has(foldToken(postNameOf(h.post ?? ""))) ||
      wanted.has(foldToken(h.settlement)),
  );
  if (kept.length) return kept;
  for (const parent of wanted) {
    if (known.parentNames.has(parent) || known.settlementNames.has(parent)) return [];
  }
  return [...hits];
}
