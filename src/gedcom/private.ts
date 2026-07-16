import type { GedNode } from "./types";

/**
 * Private-data markers.
 *
 * Programs flag a record (person, family, shared note, media…) as private in
 * three dialects:
 *  - MacFamilyTree: bare `1 PRIV` (occasionally `PRIV Y`)
 *  - MyHeritage / Brother's Keeper: `1 _PRIV Y`
 *  - the standard: `1 RESN privacy` / `confidential` (GEDCOM 7 allows a
 *    comma-separated list, e.g. `RESN CONFIDENTIAL, LOCKED`)
 *
 * `RESN NONE` (webtrees' explicit "no restriction") and `RESN locked`
 * (edit-protection) are NOT privacy. Reading recognizes all dialects; writing
 * follows the file's own (detected) dialect so the flag round-trips through
 * the program that made it.
 */

export type PrivacyTagStyle = "PRIV" | "_PRIV" | "RESN";

const RESN_PRIVATE_RE = /(^|,)\s*(privacy|confidential)\s*(,|$)/i;

/** Whether one child node is a marker flagging its parent as private. */
export function isPrivacyMarker(child: GedNode): boolean {
  const v = child.value?.trim() ?? "";
  switch (child.tag) {
    case "PRIV":
    case "_PRIV":
      return v === "" || /^y/i.test(v);
    case "RESN":
      return RESN_PRIVATE_RE.test(v);
    default:
      return false;
  }
}

/** Whether the node (a record, or an inline NOTE/OBJE) is flagged private. */
export function isPrivateNode(node: GedNode): boolean {
  return node.children.some(isPrivacyMarker);
}

/**
 * The file's own privacy dialect, from the markers it already carries (most
 * common wins; PRIV > _PRIV > RESN on ties). A file with none uses the
 * standard RESN.
 */
export function detectPrivacyStyle(records: GedNode[]): PrivacyTagStyle {
  const counts: Record<PrivacyTagStyle, number> = { PRIV: 0, _PRIV: 0, RESN: 0 };
  const countIn = (node: GedNode) => {
    for (const child of node.children) {
      if (isPrivacyMarker(child) && (child.tag === "PRIV" || child.tag === "_PRIV" || child.tag === "RESN")) {
        counts[child.tag]++;
      }
    }
  };
  for (const rec of records) {
    countIn(rec);
    for (const child of rec.children) countIn(child);
  }
  const best = (Object.keys(counts) as PrivacyTagStyle[]).reduce((a, b) => (counts[b] > counts[a] ? b : a));
  return counts[best] > 0 ? best : "RESN";
}

/** GEDCOM version of the file, for RESN's enum casing (7.0 is upper-case). */
function isV7(records: GedNode[]): boolean {
  const head = records.find((r) => r.tag === "HEAD");
  const vers = head?.children.find((c) => c.tag === "GEDC")?.children.find((c) => c.tag === "VERS")?.value;
  return !!vers?.trim().startsWith("7");
}

/** The marker node for `style`, at child level of `parent`. */
function markerNode(parent: GedNode, style: PrivacyTagStyle, records: GedNode[]): GedNode {
  const level = parent.level + 1;
  if (style === "PRIV") return { level, tag: "PRIV", children: [] };
  if (style === "_PRIV") return { level, tag: "_PRIV", value: "Y", children: [] };
  return { level, tag: "RESN", value: isV7(records) ? "PRIVACY" : "privacy", children: [] };
}

/**
 * Set or clear the private flag on `node`, following the file's dialect when
 * setting. Clearing removes every recognized marker — but a RESN list keeps
 * its non-privacy entries (`CONFIDENTIAL, LOCKED` → `LOCKED`).
 */
export function setPrivateFlag(node: GedNode, on: boolean, style: PrivacyTagStyle, records: GedNode[]): void {
  const kept: GedNode[] = [];
  for (const child of node.children) {
    if (!isPrivacyMarker(child)) {
      kept.push(child);
      continue;
    }
    if (child.tag === "RESN") {
      const rest = (child.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !/^(privacy|confidential)$/i.test(s))
        .join(", ");
      if (rest) kept.push({ ...child, value: rest });
    }
  }
  node.children = kept;
  if (on) node.children.push(markerNode(node, style, records));
}
