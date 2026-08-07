import type { AddressRow } from "./addressRegister";
import { isInCroatia, laea3035ToWgs84 } from "./laea";

// Reading the Croatian address register (DGU) out of its INSPIRE download.
// What becomes of the rows afterwards is addressRegister.ts, which Slovenia
// shares.
//
// Croatia's WFS for addresses is not public — it serves only Croatian public
// bodies — so there is no service to page through the way Slovenia's is
// (siAd.ts). What the DGU does publish is a weekly INSPIRE download,
// `INSPIRE_Addresses_(AD).zip`: 85 MB that inflate to 2.6 GB of GML holding all
// 1.68 million Croatian addresses, CORS open so the browser can fetch it
// directly.
//
// The download is four GML files. Three are small side tables the addresses
// point into by `xlink:href`, and are parsed whole:
//   - AdminUnitName.gml — 6759 naselja (4thOrder) plus the country itself
//   - ThoroughfareName.gml — 54 432 street names
//   - PostalDescriptor.gml — 900 post codes and their post offices
// The fourth, Address.gml, is the 2.6 GB one and is never held: it is read as a
// stream, one `wfs:member` at a time.
//
// Data: Državna geodetska uprava, INSPIRE download service.

/** The side tables an address member's `xlink:href`s point into. */
export interface HrSideTables {
  /** gml:id → naselje name. Also decides which of a member's two AdminUnitName
   *  links is the settlement — see {@link parseAdminUnitNames}. */
  settlements: ReadonlyMap<number, string>;
  streets: ReadonlyMap<number, string>;
  posts: ReadonlyMap<number, { line: string; name: string }>;
}

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
 * Note the axis order: the register writes `gml:pos` in the CRS's own order,
 * northing before easting, which is the opposite of the way every projection in
 * this app takes its arguments.
 *
 * Croatia files every address under a ThoroughfareName, including the villages
 * that number their houses directly — there the "street" is named after the
 * village itself, which {@link import("./addressRegister").searchBucket} reads
 * as the village numbering it is.
 */
export function parseAddressMember(member: string, tables: HrSideTables): AddressRow | undefined {
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
    else if (m[1] === "AdminUnitName" && tables.settlements.has(id)) settlementId = id;
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
    // values are a single Latin letter and a number under 110.
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
    settlementId: String(settlementId),
    settlement: tables.settlements.get(settlementId) ?? "",
    // A name unknown to its side table becomes an empty string rather than a
    // dropped address: the house is still where it is, it just cannot say what
    // street it is on.
    street: tables.streets.get(streetId) ?? "",
    post: tables.posts.get(postId)?.line ?? "",
    number,
    ext,
    ext2,
    lat: coord!.lat,
    lon: coord!.lon,
  };
}
