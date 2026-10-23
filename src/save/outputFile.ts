import { firstChild } from "../gedcom/node";
import { downloadOptions, ensureUtf8Charset, stampHeadSource, type SerializeOptions } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { versionFamily, type VersionFamily } from "../normalize/migrate";

/**
 * What a file needs, at the level of the file rather than of any record, to be
 * valid GEDCOM in the version it is written in — and the conversion between
 * the two spec families when the reader saves in the other one.
 *
 * Every download runs through {@link prepareDownload}: the save, the privacy
 * export and a chart's branch export alike. Like `stampHeadSource`, it mutates
 * the forest it is given, so it is only ever handed records about to leave.
 */

/** The spec family a download is written in. */
export type OutputVersion = VersionFamily;

/** A repair the file needed before it could be written as valid GEDCOM. Each
 *  is told to the reader once, in the save preview and in the change report
 *  (`preview.fix.*` / `changeReport.note.fix.*`). */
export type StructuralFix = "head" | "trlr" | "gedc" | "char";

/** The version a file is saved in unless the reader picks the other one. */
export function ownVersion(ds: Pick<Dataset, "version">): OutputVersion {
  return versionFamily(ds.version);
}

/** Serialize options for a download written in `version`. */
export function outputOptions(
  ds: Pick<Dataset, "eol" | "finalNewline" | "bom">,
  version: OutputVersion,
): SerializeOptions {
  return downloadOptions({ ...ds, version });
}

const line = (tag: string, value?: string, children: GedNode[] = []): GedNode => {
  const node: GedNode = { level: 0, tag, children };
  if (value !== undefined) node.value = value;
  return node;
};

/** The GEDC block a header declares `version` with. */
function gedcBlock(version: OutputVersion): GedNode {
  return version === "7.0"
    ? line("GEDC", undefined, [line("VERS", "7.0")])
    : line("GEDC", undefined, [line("VERS", "5.5.1"), line("FORM", "LINEAGE-LINKED")]);
}

/**
 * The structural repairs writing `records` as `version` needs: a header and a
 * trailer, the header's version declaration, and — for 5.5.1, which requires
 * them — the character set. With `apply`, they are made
 * (the forest is mutated); without, they are only listed, which is what the
 * preview shows before anything is written.
 */
export function completeStructure(records: GedNode[], version: OutputVersion, apply = true): StructuralFix[] {
  const fixes: StructuralFix[] = [];
  let head = records.find((r) => r.tag === "HEAD");
  if (!head) {
    fixes.push("head");
    head = line("HEAD", undefined, [gedcBlock(version)]);
    if (version !== "7.0") head.children.push(line("CHAR", "UTF-8"));
    if (apply) records.unshift(head);
  } else {
    const gedc = firstChild(head, "GEDC");
    const vers = gedc && firstChild(gedc, "VERS");
    const form = gedc && firstChild(gedc, "FORM");
    if (!vers?.value?.trim() || (version !== "7.0" && !form)) {
      fixes.push("gedc");
      if (apply) declareVersion(head, version);
    }
    if (version !== "7.0" && !firstChild(head, "CHAR")) {
      fixes.push("char");
      if (apply) {
        // 5.5.1 places CHAR right after the GEDC block.
        const at = head.children.findIndex((c) => c.tag === "GEDC");
        head.children.splice(at + 1, 0, line("CHAR", "UTF-8"));
      }
    }
  }
  if (!records.some((r) => r.tag === "TRLR")) {
    fixes.push("trlr");
    if (apply) records.push(line("TRLR"));
  }
  return fixes;
}

/** Fill in the header's GEDC block for `version`, keeping a declared version
 *  that is already there. */
function declareVersion(head: GedNode, version: OutputVersion): void {
  let gedc = firstChild(head, "GEDC");
  if (!gedc) {
    gedc = gedcBlock(version);
    // 7.0 requires GEDC first; 5.5.1 lists it after the submitter lines,
    // right before CHAR.
    const char = head.children.findIndex((c) => c.tag === "CHAR");
    head.children.splice(version === "7.0" ? 0 : char >= 0 ? char : head.children.length, 0, gedc);
    return;
  }
  const vers = firstChild(gedc, "VERS");
  if (!vers) gedc.children.unshift(line("VERS", version));
  else if (!vers.value?.trim()) vers.value = version;
  if (version !== "7.0" && !firstChild(gedc, "FORM")) gedc.children.push(line("FORM", "LINEAGE-LINKED"));
}

export interface PreparedDownload {
  /** The repairs made — see {@link completeStructure}. */
  fixes: StructuralFix[];
  /** One line per structure the conversion rewrote, or null when the file is
   *  written in its own version. */
  conversion: string[] | null;
}

/**
 * Make `records` (a clone about to be serialized) a valid file in `version`:
 * repair its structure, convert it when `version` is not the file's own,
 * declare UTF-8, stamp GED Merge as the writing system and, for 7.0, declare
 * its extension tags.
 */
export function prepareDownload(
  records: GedNode[],
  ds: Pick<Dataset, "version" | "charset">,
  version: OutputVersion = ownVersion(ds),
  date: Date = new Date(),
): PreparedDownload {
  const fixes = completeStructure(records, version);
  const conversion = null;
  ensureUtf8Charset(records, { version, charset: ds.charset });
  stampHeadSource(records, { version }, date);
  return { fixes, conversion };
}
