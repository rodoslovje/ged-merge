import { firstChild } from "./node";
import type { ExternalId, GedNode } from "./types";

/**
 * GEDCOM 7's external identifier, `EXID`: an id some other system gave the
 * record, with a `TYPE` URI naming that system —
 *
 *     1 EXID GPZG-CXL
 *     2 TYPE https://www.familysearch.org/tree/person/
 *
 * The FamilySearch one is the 7.0 form of what MacFamilyTree writes as `_FID`
 * and RootsMagic as `_FSFTID`, so it joins those everywhere the app handles a
 * FamilySearch id (Edit's chips, the merge row, matching). Every other EXID is
 * read onto {@link Individual.exids}.
 */

/** The registered EXID type for a FamilySearch Family Tree person id. */
export const FS_EXID_TYPE = "https://www.familysearch.org/tree/person/";

/** The vendor tags that carry a FamilySearch person id in 5.5.1 files. */
export const FS_VENDOR_TAGS: readonly string[] = ["_FID", "_FSFTID"];

/** Whether an EXID `TYPE` names FamilySearch Family Tree person ids — the
 *  registered URI, or a spelling of it (http, no www, a trailing path). */
export function isFsExidType(type: string | undefined): boolean {
  return !!type && /^https?:\/\/(www\.)?familysearch\.org\/tree\/person\b/i.test(type.trim());
}

/** Whether a record child carries a FamilySearch person id, in any dialect. */
export function isFsIdNode(node: GedNode): boolean {
  if (FS_VENDOR_TAGS.includes(node.tag)) return true;
  return node.tag === "EXID" && isFsExidType(firstChild(node, "TYPE")?.value);
}

/** A new line carrying a FamilySearch id, in the dialect `tag` names. */
export function fsIdNode(tag: string, value: string, level: number): GedNode {
  const node: GedNode = { level, tag, value, children: [] };
  if (tag === "EXID") node.children.push({ level: level + 1, tag: "TYPE", value: FS_EXID_TYPE, children: [] });
  return node;
}

/** Read one `EXID` line. */
export function readExid(node: GedNode): ExternalId | undefined {
  const id = node.value?.trim();
  if (!id) return undefined;
  const type = firstChild(node, "TYPE")?.value?.trim();
  return type ? { id, type } : { id };
}

/** EXID types that number records within one file — never the same person
 *  across two files, so never an identity for matching. */
const LOCAL_ID_TYPES = new Set(["https://gedcom.io/terms/v7/RIN", "https://gedcom.io/terms/v7/RFN"]);

/** The identity key an EXID gives matching: its type and id together, or
 *  nothing for an untyped or file-local one. */
export function exidIdentityKey(exid: ExternalId): string | undefined {
  if (!exid.type || LOCAL_ID_TYPES.has(exid.type) || exid.id.length < 3) return undefined;
  return `${exid.type.toLowerCase()}|${exid.id}`;
}

/** A short, readable name for an EXID type: the URI's host and path, or the
 *  type as written when it is no URI. */
export function exidTypeLabel(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const m = /^https?:\/\/(?:www\.)?([^?#]+?)\/?$/i.exec(type.trim());
  return m ? m[1] : type.trim();
}
