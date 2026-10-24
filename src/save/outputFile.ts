import { submitterName } from "../gedcom/newFile";
import { firstChild } from "../gedcom/node";
import { downloadOptions, ensureUtf8Charset, stampHeadSource, type SerializeOptions } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { migrateVersion, versionFamily, type VersionFamily } from "../normalize/migrate";
import { walkNodes } from "../normalize/walk";
import { registryEntry } from "../gedcom/extensionRegistry";
import { termsUri } from "../gedcom/extensionTerms";

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
 *  (both read the `preview.fix.*` strings) and in Tools → Health check. */
export type StructuralFix = "head" | "trlr" | "gedc" | "char" | "subm";

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
 * them — the character set and a submitter. With `apply`, they are made
 * (the forest is mutated); without, they are only listed, which is what the
 * preview shows before anything is written. A submitter record made here is
 * named `authorName` (the reader's name from Settings), or the program's name
 * when it is empty; one the file already has is never touched.
 */
export function completeStructure(
  records: GedNode[],
  version: OutputVersion,
  apply = true,
  authorName?: string,
): StructuralFix[] {
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
  if (version !== "7.0" && ensureSubmitter(records, head, apply, authorName)) fixes.push("subm");
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

/**
 * Point `HEAD.SUBM` at a submitter record that exists, making one when the
 * file has none (5.5.1 requires both). A header pointing at a record the file
 * lacks gets that record, under the xref it already names. Returns whether
 * anything was (or, without `apply`, would be) added.
 */
function ensureSubmitter(records: GedNode[], head: GedNode, apply: boolean, authorName?: string): boolean {
  const submitters = records.filter((r) => r.tag === "SUBM" && r.xref);
  const pointer = firstChild(head, "SUBM");
  const target = pointer?.value?.trim();
  if (target && submitters.some((r) => r.xref === target)) return false;
  if (!apply) return true;
  let xref = target && /^@[^@]+@$/.test(target) ? target : submitters[0]?.xref;
  if (!xref) {
    const taken = new Set(records.map((r) => r.xref));
    let n = 1;
    while (taken.has(`@U${n}@`)) n++;
    xref = `@U${n}@`;
  }
  if (!submitters.some((r) => r.xref === xref)) {
    const record = line("SUBM", undefined, [line("NAME", submitterName(authorName))]);
    record.xref = xref;
    const trlr = records.findIndex((r) => r.tag === "TRLR");
    records.splice(trlr >= 0 ? trlr : records.length, 0, record);
  }
  if (pointer) {
    pointer.value = xref;
  } else {
    // 5.5.1's header order: SOUR, DEST, DATE, then SUBM.
    let at = -1;
    head.children.forEach((c, i) => { if (c.tag === "SOUR" || c.tag === "DEST" || c.tag === "DATE") at = i; });
    head.children.splice(at + 1, 0, line("SUBM", xref));
  }
  return true;
}

/**
 * Rewrite `records` from one spec family into the other: every record through
 * `migrateVersion` (shared notes, dates, ages, associations, identifiers,
 * media), and the header, which migration leaves alone, here. Returns one
 * readable line per rewritten structure, for the preview and the report.
 */
export function convertVersion(records: GedNode[], from: OutputVersion, to: OutputVersion): string[] {
  const changes: string[] = [];
  if (from === to) return changes;
  const note = (before: string, after: string) => changes.push(`${before} → ${after}`);
  migrateVersion(records, from, to, note);
  // A converted file is written by its new version's at-sign rule throughout.
  walkNodes(records, (node) => { delete node.atBare; });

  const head = records.find((r) => r.tag === "HEAD");
  if (head) {
    declareVersion(head, to);
    const gedc = firstChild(head, "GEDC")!;
    const vers = firstChild(gedc, "VERS")!;
    if (vers.value !== to) {
      note(`GEDC.VERS ${vers.value ?? ""}`.trim(), `GEDC.VERS ${to}`);
      vers.value = to;
    }
    if (to === "7.0") {
      // 7.0's GEDC holds the version alone, and its header has no CHAR (the
      // file is UTF-8 by definition) nor FILE; GEDC must come first.
      dropChildren(gedc, ["FORM"], note);
      dropChildren(head, ["CHAR", "FILE"], note);
      head.children = [gedc, ...head.children.filter((c) => c !== gedc)];
    } else {
      // 5.5.1 knows no schema; its extension tags need no declaration.
      dropChildren(head, ["SCHMA"], note);
    }
  }

  // 7.0 dropped the submission record; its content is kept as an extension.
  for (const node of [...records, ...(head?.children ?? [])]) {
    if (to === "7.0" && node.tag === "SUBN") {
      note(node.xref ? `SUBN ${node.xref}` : "HEAD.SUBN", "_SUBN");
      node.tag = "_SUBN";
      delete node.spelling;
    }
  }
  return changes;
}

function dropChildren(parent: GedNode, tags: string[], note: (b: string, a: string) => void): void {
  parent.children = parent.children.filter((c) => {
    if (!tags.includes(c.tag)) return true;
    note(`${parent.tag}.${c.tag}${c.value ? ` ${c.value}` : ""}`, "—");
    return false;
  });
}

/**
 * The URI `HEAD.SCHMA` declares an extension tag with, where it stands
 * (`ancestors`: the tags above it, record first): the FamilySearch registry's
 * URI where the registration covers that place and spelling, else the GED
 * Merge page documenting the tag as the file's producer (`headSour`) writes
 * it (see `gedcom/extensionTerms.ts`). A tag with a standard 7.0 form never
 * gets here: converting to 7.0 writes the standard form instead.
 */
export function schemaUri(tag: string, ancestors: readonly string[], headSour: string | undefined): string {
  const registered = registryEntry(tag, ancestors);
  if (registered && registered.tag === tag) return registered.uri;
  return termsUri(tag, headSour);
}

/**
 * Declare every extension (`_`) tag in a GEDCOM 7 forest in `HEAD.SCHMA`, as
 * 7.0 asks of a file that uses them, each with {@link schemaUri} for the first
 * place it appears (a schema gives a tag one URI). Entries the header already
 * has are kept and never repeated. `headSour` is the system that wrote the
 * file — read before the save stamps GED Merge in its place. Returns the tags
 * added.
 */
export function writeSchema(records: GedNode[], headSour?: string): string[] {
  const head = records.find((r) => r.tag === "HEAD");
  if (!head) return [];
  const used = new Map<string, string>();
  const visit = (nodes: GedNode[], ancestors: string[]) => {
    for (const node of nodes) {
      if (node.tag.startsWith("_")) {
        // As the 7.0 download writes it: uppercase (`upperTags`).
        const tag = node.tag;
        if (!used.has(tag)) used.set(tag, schemaUri(tag, ancestors, headSour));
      }
      if (node.children.length) visit(node.children, [...ancestors, node.tag]);
    }
  };
  visit(records, []);
  let schma = firstChild(head, "SCHMA");
  const declared = new Set(
    (schma?.children ?? []).filter((c) => c.tag === "TAG").map((c) => c.value?.trim().split(/\s+/)[0]),
  );
  const added = [...used.keys()].filter((tag) => !declared.has(tag)).sort();
  if (added.length === 0) return added;
  if (!schma) {
    schma = line("SCHMA");
    // After GEDC, which 7.0 puts first.
    const at = head.children.findIndex((c) => c.tag === "GEDC");
    head.children.splice(at + 1, 0, schma);
  }
  for (const tag of added) schma.children.push(line("TAG", `${tag} ${used.get(tag)}`));
  return added;
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
 * its extension tags. `authorName` names a submitter record the file needs
 * and lacks (see {@link completeStructure}).
 */
export function prepareDownload(
  records: GedNode[],
  ds: Pick<Dataset, "version" | "charset">,
  version: OutputVersion = ownVersion(ds),
  date: Date = new Date(),
  authorName?: string,
): PreparedDownload {
  const from = ownVersion(ds);
  // The program that wrote the file, before the stamp below names GED Merge.
  const headSour = firstChild(records.find((r) => r.tag === "HEAD") ?? line("HEAD"), "SOUR")?.value;
  const fixes = completeStructure(records, version, true, authorName);
  const conversion = from === version ? null : convertVersion(records, from, version);
  ensureUtf8Charset(records, { version, charset: ds.charset });
  stampHeadSource(records, { version }, date);
  if (version === "7.0") writeSchema(records, headSour);
  return { fixes, conversion };
}
