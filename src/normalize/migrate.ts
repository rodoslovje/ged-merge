import type { GedcomVersion, GedNode } from "../gedcom/types";
import { RELA_TO_ROLE, ROLE_TO_RELA, VOID_XREF } from "../gedcom/assoc";
import { firstChild, childrenByTag } from "../gedcom/node";
import { moveAssociation } from "../gedcom/edit";
import { hangMediaLinesUnderFile, MIME_TO_EXT, mimeFormOf, relevelRecords } from "../gedcom/mediaForm";
import { readSex, SEX_X_EXTENSION } from "../gedcom/sex";
import { NAME_TYPES_551, nameType70, splitSlashName } from "../gedcom/name";
import { FS_EXID_TYPE, FS_VENDOR_TAGS, isFsExidType } from "../gedcom/exid";
import { allowsChild, enumValuesAt } from "../tools/conformance/allows";
import { isHtmlNote } from "../gedcom/noteHtml";
import { walkNodes } from "./walk";

/**
 * GEDCOM version migration: rewrite the compare file's version-specific
 * structures into the main file's GEDCOM version, so records merged into the
 * main stay valid for its spec. Runs as the first normalization pass, before
 * the house-style (date/place/name) reshaping.
 *
 * Covered, in both directions:
 *  - shared-note records and pointers  : `NOTE` record  ⇄  `SNOTE`
 *  - name/place variants               : `ROMN`/`FONE` + TYPE  ⇄  `TRAN` + LANG
 *  - date syntax                       : `INT date (phrase)` / `(phrase)` ⇄
 *                                        DATE + `PHRASE` substructure; dual
 *                                        years; BC ⇄ BCE; `@#DJULIAN@` ⇄
 *                                        `JULIAN` calendar prefix
 *  - age syntax                        : `CHILD`/`INFANT`/`STILLBORN` keywords ⇄
 *                                        bounded ages + `PHRASE`; unit casing;
 *                                        weeks (7-only) ⇄ days
 *  - associations                      : `ASSO`.`RELA` free text ⇄ `ROLE` enum
 *                                        (+ `PHRASE` for OTHER); `TYPE INDI`
 *                                        dropped on the way up, and on the way
 *                                        down an event's or a family's `ASSO`
 *                                        moved to the one record 5.5.1 allows
 *  - identifiers                       : `AFN`/`RFN`/`RIN` ⇄ `EXID` + TYPE URI
 *                                        (a FamilySearch EXID ⇄ `_FSFTID`/`_FID`;
 *                                        other EXIDs ⇄ `REFN` + URI `TYPE`);
 *                                        `_UID` ⇄ `UID`
 *  - married surnames                  : a `NAME`'s `_MARNM` ⇄ a `NAME` of its
 *                                        own with `TYPE MARRIED`
 *  - name types                        : `NAME`.`TYPE` `aka`/`married`/… ⇄
 *                                        `AKA`/`MARRIED`/… (7.0's enumeration);
 *                                        `variation` → `AKA`, any other word ⇄
 *                                        `OTHER` + `PHRASE`
 *  - media                             : `FORM` file extension ⇄ IANA media
 *                                        type, record-level `FORM`/`TITL`
 *                                        moved under `FILE`, `TYPE` ⇄ `MEDI`
 *  - LDS ordinance status              : `STAT` `PRE-1970`/`DNS/CAN` (and any
 *                                        casing) ⇄ the `PRE_1970`/`DNS_CAN`
 *                                        enumeration; the ordinance tags
 *                                        themselves, `TEMP`, `STAT`.`DATE`
 *                                        and the sealing's `FAMC` are spelled
 *                                        alike in both
 *  - enumerations                      : `PEDI`, a child link's `STAT`, `MEDI`
 *                                        and `RESN` lower case ⇄ upper case,
 *                                        from the spec tables; 7.0 `OTHER` +
 *                                        `PHRASE`; a `RESN` list → its strongest
 *  - 7-only structures on downgrade    : `UID` → `_UID`, `CREA` → `_CREA`,
 *                                        `NO` → `_NO`, `SDATE` → `_SDATE` (all
 *                                        but `_CREA` restored on the way up), a
 *                                        note's `MIME`/`LANG`/`TRAN` → `_…`,
 *                                        `@VOID@` pointers (see below),
 *                                        `SEX X` → `SEX U` + `_SEX X` (and back),
 *                                        an event date's `TIME` → `_TIME` (and back),
 *                                        a media record's `RESN` → `_RESN` (and back),
 *                                        any other `PHRASE` → a `NOTE`, a
 *                                        `RESI`'s text → its `NOTE`
 *
 * A vendor line the upgrade turns into its standard form remembers what it was
 * (`GedNode.upgradedFrom`), so the downgrade gives back that very line — `_FID`
 * rather than the `_FSFTID` it writes for a FamilySearch EXID the file had of
 * its own, and the `_MARNM` rather than the married `NAME` (valid 5.5.1 too).
 *
 * A text `SOUR` citation becomes `SOUR @VOID@` with its text as `PAGE` (and
 * back). An inline `OBJE` becomes a media record of its own, pointed to from
 * where it was (and, while the forest remembers it, back inline).
 */

/** The two spec families migration distinguishes. An `unknown` declared
 *  version is treated as legacy 5.5.x, matching the serializer's convention. */
export type VersionFamily = "5.5.1" | "7.0";

export function versionFamily(v: GedcomVersion): VersionFamily {
  return v === "7.0" ? "7.0" : "5.5.1";
}

/** Roots the record-level migration leaves alone: the header and the
 *  submission record are `convertVersion`'s (src/save/outputFile.ts), the
 *  trailer has nothing. The submitter is a record like any other. */
const SKIP_ROOTS = new Set(["HEAD", "TRLR", "SUBN"]);

/**
 * Migrate `records` in place between spec families. Reports each rewritten
 * node through `onChange` (a readable before/after pair) and returns the
 * number of nodes changed.
 */
export function migrateVersion(
  records: GedNode[],
  from: VersionFamily,
  to: VersionFamily,
  onChange: (before: string, after: string) => void,
): number {
  if (from === to) return 0;
  // The conversion asks `level` where a tag sits; a merged line's may be stale.
  relevelRecords(records);
  const ctx: MigrateCtx = { changed: 0, onChange };
  if (to === "5.5.1") inlineExtractedMedia(records, ctx);
  const migratable = records.filter((r) => !SKIP_ROOTS.has(r.tag));
  if (to === "7.0") {
    upgrade(migratable, ctx);
    extractInlineMedia(records, ctx);
    upgradeFamilyAssociations(migratable, ctx);
  } else {
    downgrade(migratable, ctx);
    downgradeSubmitterRefns(migratable, ctx);
    downgradeHeadNote(records, ctx);
  }
  // After the media moves, so every enumeration sits where the target has it.
  const settled = records.filter((r) => !SKIP_ROOTS.has(r.tag));
  migrateEnums(settled, ctx, to);
  if (to === "5.5.1") downgradeLeftovers(settled, ctx);
  return ctx.changed;
}

/**
 * 7.0's submitter may carry a `REFN` (and an `EXID` the downgrade could only
 * make one of); 5.5.1's has no `REFN`. It is kept as the `_REFN` extension.
 */
function downgradeSubmitterRefns(records: GedNode[], ctx: MigrateCtx): void {
  for (const subm of records) {
    if (subm.tag !== "SUBM") continue;
    for (const refn of childrenByTag(subm, "REFN")) {
      const before = `SUBM.${describe(refn)}`;
      retag(refn, "_REFN");
      ctx.changed++;
      ctx.onChange(before, `SUBM.${describe(refn)}`);
    }
  }
}

/**
 * 7.0's header may point at a shared note (`HEAD.SNOTE @N1@`); 5.5.1's header
 * note is text only. The note's text is copied in (joined to a text note the
 * header already has, as 5.5.1 allows one), and the record stays for its
 * other referrers. A pointer to no note says nothing and is dropped.
 */
function downgradeHeadNote(records: GedNode[], ctx: MigrateCtx): void {
  const head = records.find((r) => r.tag === "HEAD");
  if (!head?.children.some((c) => c.tag === "SNOTE")) return;
  const notes = new Map(records.filter((r) => r.tag === "NOTE" && r.xref).map((r) => [r.xref!, r]));
  for (const snote of childrenByTag(head, "SNOTE")) {
    const before = `HEAD.${describe(snote)}`;
    const rec = notes.get(snote.value?.trim() ?? "");
    ctx.changed++;
    const own = firstChild(head, "NOTE");
    if (!rec) {
      head.children = head.children.filter((c) => c !== snote);
      ctx.onChange(before, "—");
      continue;
    }
    const text = rec.value ?? "";
    if (own) {
      own.value = own.value ? `${own.value}\n${text}` : text;
      head.children = head.children.filter((c) => c !== snote);
    } else {
      snote.tag = "NOTE";
      snote.value = text;
      snote.children = [];
    }
    ctx.onChange(before, "HEAD.NOTE (text)");
  }
}

interface MigrateCtx {
  changed: number;
  onChange: (before: string, after: string) => void;
}

function report(ctx: MigrateCtx, node: GedNode, before: string): void {
  ctx.changed++;
  ctx.onChange(before, describe(node));
}

function describe(node: GedNode): string {
  const id = node.xref ?? node.value;
  return id !== undefined ? `${node.tag} ${id}` : node.tag;
}

function isPointer(value: string | undefined): value is string {
  return value !== undefined && /^@[^@]+@$/.test(value);
}

function plain(tag: string, value?: string): GedNode {
  const node: GedNode = { level: 0, tag, children: [] };
  if (value !== undefined) node.value = value;
  return node;
}

/** The ordinance statuses 7.0 enumerates. 5.5.1 lists the same set, two of
 *  them punctuated differently (see {@link STAT_DOWNGRADES}). */
const STAT_ENUM = new Set([
  "BIC", "CANCELED", "CHILD", "COMPLETED", "EXCLUDED", "DNS", "DNS_CAN", "INFANT", "PRE_1970", "STILLBORN", "SUBMITTED", "UNCLEARED",
]);

/** 7.0 status → its 5.5.1 spelling, where the two differ. */
const STAT_DOWNGRADES: Record<string, string> = { PRE_1970: "PRE-1970", DNS_CAN: "DNS/CAN" };

/** Rewrite an ordinance's `STAT` value into the target version's spelling. A
 *  value neither standard defines is left as the file writes it. */
function migrateStat(node: GedNode, ctx: MigrateCtx, to: VersionFamily): void {
  const raw = node.value?.trim();
  if (!raw) return;
  const upper = raw.toUpperCase().replace(/[-/ ]/g, "_");
  if (!STAT_ENUM.has(upper)) return;
  const next = to === "7.0" ? upper : (STAT_DOWNGRADES[upper] ?? upper);
  if (next === node.value) return;
  const before = describe(node);
  node.value = next;
  report(ctx, node, before);
}

/**
 * Depth-first visit with the tags from the record down to the node (the
 * record's first) and the nodes along that path. Extension subtrees are not
 * entered: what lies under a `_` tag is the extension's own business.
 */
function walkWithPath(records: GedNode[], visit: (node: GedNode, path: string[], line: GedNode[]) => void): void {
  const path: string[] = [];
  const line: GedNode[] = [];
  const go = (node: GedNode): void => {
    path.push(node.tag);
    line.push(node);
    visit(node, path, line);
    for (const child of [...node.children]) if (!child.tag.startsWith("_")) go(child);
    path.pop();
    line.pop();
  };
  for (const rec of records) go(rec);
}

/** The enumerations {@link migrateEnums} respells: `PEDI`, a child link's
 *  `STAT`, `MEDI` (5.5.1's `TYPE` under a media `FORM`) and `RESN`. ROLE, a
 *  name's TYPE and an ordinance's STAT have conversions of their own. */
function isRespelledEnum(tag: string, parentTag: string | undefined): boolean {
  return tag === "PEDI" || tag === "MEDI" || tag === "RESN"
    || (tag === "STAT" && parentTag === "FAMC") || (tag === "TYPE" && parentTag === "FORM");
}

/** 5.5.1's `RESN` holds one value where 7.0's holds a list: the strongest
 *  restriction of the list is the one kept. */
const RESN_STRENGTH = ["confidential", "privacy", "locked"];

/**
 * Spell `PEDI`, a child link's `STAT`, `MEDI` and `RESN` as the target version
 * does, with the values the spec tables give for the line's place. 7.0 is
 * upper case, and a value outside its set becomes `OTHER` with the value as
 * its `PHRASE`. 5.5.1 is lower case: an `OTHER` takes its `PHRASE` when that
 * is a 5.5.1 value, and is dropped otherwise, the `PHRASE` left in its place
 * for {@link downgradeLeftovers} to keep as a note. A 7.0 `RESN` list narrows
 * to its strongest restriction.
 */
function migrateEnums(records: GedNode[], ctx: MigrateCtx, to: VersionFamily): void {
  walkWithPath(records, (node, path, line) => {
    const raw = node.value?.trim();
    if (!raw || !isRespelledEnum(node.tag, path[path.length - 2])) return;
    const set = enumValuesAt(to, path);
    if (!set) return;
    const before = describe(node);
    const find = (v: string) => set.find((s) => s.toLowerCase() === v.toLowerCase());
    const items = node.tag === "RESN" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [raw];
    const phrase = firstChild(node, "PHRASE");
    if (to === "7.0") {
      const hits = items.map(find);
      let next: string | undefined;
      if (hits.every((h) => h !== undefined)) next = hits.join(", ");
      else if (items.length === 1 && set.includes("OTHER") && !raw.startsWith("_")) {
        next = "OTHER";
        if (!phrase) node.children.unshift(plain("PHRASE", raw));
      }
      if (next === undefined || next === node.value) return;
      node.value = next;
      report(ctx, node, before);
      return;
    }
    const other = items.length === 1 && raw.toUpperCase() === "OTHER";
    const hits = (other ? [phrase?.value?.trim() ?? ""] : items).map(find);
    if (hits.every((h): h is string => h !== undefined)) {
      const rank = (v: string) => (RESN_STRENGTH.includes(v) ? RESN_STRENGTH.indexOf(v) : RESN_STRENGTH.length);
      const next = [...hits].sort((a, b) => rank(a) - rank(b))[0];
      if (next === node.value && !other) return;
      node.value = next;
      if (other) node.children = node.children.filter((c) => c !== phrase);
      report(ctx, node, before);
    } else if (other) {
      // 5.5.1 has no OTHER: the line goes, and what its PHRASE said stays.
      const parent = line[line.length - 2];
      parent.children.splice(parent.children.indexOf(node), 1, ...(phrase ? [phrase] : []));
      ctx.changed++;
      ctx.onChange(before, "—");
    }
  });
}

/** 5.5.1's stand-in for an event date's 7.0 `TIME`. */
const TIME_EXTENSION = "_TIME";

/** 5.5.1's stand-in for a media record's 7.0 `RESN`, which 5.5.1 allows on
 *  people, families and events but not on a media record. */
const OBJE_RESN_EXTENSION = "_RESN";

/**
 * The last 7.0 lines a 5.5.1 file cannot hold, once every other conversion
 * has run: an event date's `TIME` (see {@link TIME_EXTENSION}). A `PHRASE` the conversions did not fold into their own 5.5.1 form
 * (a date's, an age keyword's, a role's, a name type's, an OTHER's) — under a
 * PEDI, a child link's STAT, a MEDI, a family's HUSB/WIFE/CHIL, an ALIA, an
 * adoption's ADOP, an ASSO, an age — becomes a NOTE with its text, on the
 * nearest line up that 5.5.1 lets carry one (the spec table says which).
 */
function downgradeLeftovers(records: GedNode[], ctx: MigrateCtx): void {
  walkWithPath(records, (node, path, line) => {
    // 5.5.1 times only a header's and a change stamp's date: an event's
    // `TIME` is kept as `_TIME`, which the upgrade restores.
    if (node.tag === "DATE" && !allowsChild("5.5.1", path, "TIME")) {
      for (const time of childrenByTag(node, "TIME")) {
        const before = `DATE.${describe(time)}`;
        report(ctx, retag(time, TIME_EXTENSION), before);
      }
    }
    for (const phrase of childrenByTag(node, "PHRASE")) {
      const text = phrase.value?.trim();
      const before = `${node.tag}.${describe(phrase)}`;
      let depth = line.length - 1;
      while (depth >= 0 && !allowsChild("5.5.1", path.slice(0, depth + 1), "NOTE")) depth--;
      const host = text && depth >= 0 ? line[depth] : undefined;
      node.children = node.children.filter((c) => c !== phrase);
      ctx.changed++;
      if (!host) {
        ctx.onChange(before, "—");
        continue;
      }
      const note: GedNode = { level: host.level + 1, tag: "NOTE", value: phrase.value, children: [] };
      host.children.push(note);
      ctx.onChange(before, `${host.tag}.${describe(note)}`);
    }
  });
}

/** Rewrite a name's `TYPE` into the target version's terms. 7.0 has a closed,
 *  upper-case enumeration: a word outside it becomes the value it plainly
 *  means, or `OTHER` with the word as its `PHRASE`. 5.5.1 spells its five in
 *  lower case and takes any other word as it is — the `PHRASE`'s, on the way down. */
function migrateNameType(name: GedNode, ctx: MigrateCtx, to: VersionFamily): void {
  const type = firstChild(name, "TYPE");
  const raw = type?.value?.trim();
  if (!type || !raw) return;
  const before = describe(type);
  if (to === "7.0") {
    const next = nameType70(raw);
    if (next.type === type.value) return;
    type.value = next.type;
    if (next.phrase && !firstChild(type, "PHRASE")) type.children.unshift(plain("PHRASE", next.phrase));
  } else {
    const phrase = firstChild(type, "PHRASE");
    const word = (raw.toUpperCase() === "OTHER" && phrase?.value?.trim()) || raw;
    const next = NAME_TYPES_551.has(word.toLowerCase()) ? word.toLowerCase() : word;
    if (next === type.value && !phrase) return;
    type.value = next;
    type.children = type.children.filter((c) => c.tag !== "PHRASE");
  }
  report(ctx, type, before);
}

/* ------------------------------- 5.5.1 → 7.0 ------------------------------ */

/** ROMN/FONE `TYPE` token → BCP-47 language tag (per the migration guide). */
const TYPE_TO_LANG: Record<string, string> = {
  kana: "ja-Hrkt",
  romaji: "ja-Latn",
  pinyin: "und-Latn-pinyin",
  wadegiles: "zh-Latn-wadegile",
  hangul: "ko",
  cyrillic: "und-Cyrl",
};

/** Identifier tags folded into EXID in 7.0, with their registered type URIs. */
const EXID_TYPE_URI: Record<string, string> = {
  AFN: "https://gedcom.io/terms/v7/AFN",
  RFN: "https://gedcom.io/terms/v7/RFN",
  RIN: "https://gedcom.io/terms/v7/RIN",
};

const URI_TO_EXID_TAG: Record<string, string> = Object.fromEntries(
  Object.entries(EXID_TYPE_URI).map(([tag, uri]) => [uri, tag]),
);

/** 5.5.1 stand-ins for 7-only structures (see `UNDERSCORE_DOWNGRADES`) that
 *  the upgrade restores, and `_UID`, the vendor tag 7.0 standardized as `UID`.
 *  `_CREA` stays: Ancestry writes it as a bare timestamp, not 7.0's
 *  `CREA` + `DATE` shape. */
const UNDERSCORE_UPGRADES: Record<string, string> = {
  _NO: "NO",
  _SDATE: "SDATE",
  _UID: "UID",
};

/** 7.0's `NAME.TYPE` for a married name. */
const MARRIED_TYPE = "MARRIED";

/** Retag a vendor line to its standard form, remembering what it was. */
function upgradeVendor(node: GedNode, tag: string, extra: { index?: number; value?: string } = {}): GedNode {
  node.upgradedFrom = { tag: node.tag, ...(node.spelling ? { spelling: node.spelling } : {}), ...extra };
  delete node.spelling;
  node.tag = tag;
  return node;
}

/** Calendar escapes: 5.5.1 `@#DJULIAN@ ...` ⇄ 7.0 `JULIAN ...` prefix. */
const CALENDAR_ESCAPES: Record<string, string> = {
  DGREGORIAN: "GREGORIAN",
  DJULIAN: "JULIAN",
  DHEBREW: "HEBREW",
  "DFRENCH R": "FRENCH_R",
};

function upgrade(records: GedNode[], ctx: MigrateCtx): void {
  // Shared notes: `0 @N1@ NOTE` records become SNOTE, and every pointer to
  // one follows. Text NOTE substructures are unchanged (still valid in 7).
  const noteXrefs = new Set(
    records.filter((r) => r.tag === "NOTE" && r.xref).map((r) => r.xref!),
  );
  for (const rec of records) {
    if (rec.tag === "NOTE" && rec.xref) {
      report(ctx, retag(rec, "SNOTE"), `NOTE ${rec.xref}`);
    }
  }

  for (const rec of records) if (rec.tag === "INDI") upgradeMarriedNames(rec, ctx);
  for (const rec of records) {
    for (const { node, type } of untypedEvents(rec)) {
      const before = `${rec.tag}.${describe(node)}`;
      node.children.unshift({ level: node.level + 1, tag: "TYPE", value: type, children: [] });
      ctx.changed++;
      ctx.onChange(before, `${rec.tag}.${node.tag}.TYPE ${type}`);
    }
  }

  walkNodes(records, (node) => {
    if (upgradeExtensionNode(node, ctx)) return;
    upgradeHtmlNote(node, ctx);
    if (node.tag === "NOTE" && isPointer(node.value) && noteXrefs.has(node.value)) {
      report(ctx, retag(node, "SNOTE"), `NOTE ${node.value}`);
      keepNoteCitations(node, ctx);
    } else if (node.tag === "ROMN" || node.tag === "FONE") {
      upgradeRomnFone(node, ctx);
    } else if (node.tag === "DATE" && node.value !== undefined) {
      upgradeDate(node, ctx);
    } else if (node.tag === "AGE" && node.value !== undefined) {
      upgradeAge(node, ctx);
    } else if (node.tag === "ASSO") {
      upgradeAsso(node, ctx);
    } else if (node.tag in EXID_TYPE_URI && node.level > 0 && node.value !== undefined) {
      const before = describe(node);
      node.children.push(plain("TYPE", EXID_TYPE_URI[node.tag]));
      report(ctx, retag(node, "EXID"), before);
    } else if (node.tag === "REFN" && /^https?:\/\//i.test(firstChild(node, "TYPE")?.value?.trim() ?? "")) {
      // A reference typed by a URI is what the downgrade makes of an EXID it
      // has no 5.5.1 tag for — and what 7.0 calls an external identifier.
      report(ctx, retag(node, "EXID"), describe(node));
    } else if (node.tag === "REPO" && node.level > 0 && !node.value?.trim()) {
      // A repository citation with no repository record (a call number
      // alone): 5.5.1 leaves its pointer out, 7.0 points it at @VOID@.
      const before = describe(node);
      node.value = VOID_XREF;
      report(ctx, node, before);
    } else if (node.tag === "OBJE" && node.children.length > 0) {
      upgradeObje(node, ctx);
    } else if (node.tag === "SOUR" && node.level > 0 && !isPointer(node.value?.trim())) {
      upgradeTextCitation(node, ctx);
    } else if (node.tag === "SEX" && node.value !== undefined) {
      const letter = { MALE: "M", FEMALE: "F", UNKNOWN: "U" }[node.value.trim().toUpperCase()];
      if (letter && node.value !== letter) {
        const before = describe(node);
        node.value = letter;
        report(ctx, node, before);
      }
    } else if (node.tag === "STAT" && node.level > 0) {
      migrateStat(node, ctx, "7.0");
    } else if (node.tag === "NAME" && node.level > 0) {
      migrateNameType(node, ctx, "7.0");
    }
  });
}

/** 5.5.1 recognizes a note's markup from its text; 7.0 names it on a
 *  `MIME text/html` line, which a note whose text is HTML (by the editor's
 *  own test, `isHtmlNote`) gets. */
function upgradeHtmlNote(node: GedNode, ctx: MigrateCtx): void {
  if ((node.tag !== "NOTE" && node.tag !== "SNOTE") || isPointer(node.value)) return;
  if (firstChild(node, "MIME") || !isHtmlNote(node.value ?? "")) return;
  node.children.unshift({ level: node.level + 1, tag: "MIME", value: "text/html", children: [] });
  const id = node.xref ? `${node.tag} ${node.xref}` : node.tag;
  ctx.changed++;
  ctx.onChange(id, `${id}.MIME text/html`);
}

/** The extension a shared-note pointer's own citations are kept under in 7.0
 *  (see {@link keepNoteCitations}). */
const NOTE_CITATION_EXTENSION = "_NOTE_SOUR";

/**
 * 5.5 let a pointer to a shared note carry citations (`1 NOTE @N1@` /
 * `2 SOUR @S1@`); 7.0's `SNOTE` pointer has no lines of its own. Moving them
 * onto the note record would cite the note for every record sharing it, so
 * they stay where they are, as an extension (and stay one in 5.5.1, whose
 * note pointer has no citations either).
 */
function keepNoteCitations(snote: GedNode, ctx: MigrateCtx): void {
  for (const sour of childrenByTag(snote, "SOUR")) {
    const before = `SNOTE ${snote.value}.${describe(sour)}`;
    retag(sour, NOTE_CITATION_EXTENSION);
    delete sour.spelling;
    ctx.changed++;
    ctx.onChange(before, `SNOTE ${snote.value}.${describe(sour)}`);
  }
}

function retag(node: GedNode, tag: string): GedNode {
  node.tag = tag;
  return node;
}

/**
 * One line's extension restated as the 7.0 structure it stands in for (see
 * `STANDARD_FORMS` in gedcom/extensionTerms.ts): a note's `_MIME`/`_LANG`/
 * `_TRAN`, a FamilySearch id as `EXID`, 5.5.1's stand-in for `SEX X`, and
 * `_NO`/`_SDATE`/`_UID`. True when the line itself was rewritten.
 */
function upgradeExtensionNode(node: GedNode, ctx: MigrateCtx): boolean {
  // A note's own lines the downgrade kept as `_MIME`/`_LANG`/`_TRAN` (see
  // NOTE_DOWNGRADES) are 7.0 structures again.
  if ((node.tag === "NOTE" || node.tag === "SNOTE") && !isPointer(node.value)) {
    for (const c of node.children) {
      const up = NOTE_UPGRADES[c.tag];
      if (up) report(ctx, retag(c, up), `${node.tag}.${describe(c)}`);
    }
    return false;
  }
  // A media record's restriction, which the downgrade kept as `_RESN`.
  if (node.tag === "OBJE" && node.level === 0) {
    for (const c of childrenByTag(node, OBJE_RESN_EXTENSION)) {
      const before = `OBJE.${describe(c)}`;
      report(ctx, retag(c, "RESN"), before);
    }
    return false;
  }
  // An event date's time, which the downgrade kept as `_TIME`.
  if (node.tag === "DATE") {
    for (const c of childrenByTag(node, TIME_EXTENSION)) {
      const before = `DATE.${describe(c)}`;
      report(ctx, retag(c, "TIME"), before);
    }
    return false;
  }
  if (FS_VENDOR_TAGS.includes(node.tag) && node.level === 1 && node.value?.trim()) {
    // A FamilySearch person id in a vendor tag: 7.0's EXID says it outright.
    const before = describe(node);
    node.children.push(plain("TYPE", FS_EXID_TYPE));
    report(ctx, upgradeVendor(node, "EXID"), before);
    return true;
  }
  // The 5.5.1 stand-in for X (`SEX U` + `_SEX X`) becomes the real letter.
  if (node.tag === "SEX" && node.value !== undefined && readSex(node) === "X" && node.value.trim().toUpperCase() !== "X") {
    const before = describe(node);
    node.value = "X";
    node.children = node.children.filter((c) => c.tag !== SEX_X_EXTENSION);
    report(ctx, node, before);
    return true;
  }
  if (node.tag in UNDERSCORE_UPGRADES && node.level > 0) {
    // The stand-ins this migration's own downgrade writes for 7-only
    // structures go back to their real tags, `_UID` to the one 7.0 adopted.
    const before = describe(node);
    report(ctx, upgradeVendor(node, UNDERSCORE_UPGRADES[node.tag]), before);
    return true;
  }
  return false;
}

/**
 * The extension tags a 7.0 file carries where 7.0 has a structure of its own,
 * restated as that structure — the same rewrites the 5.5.1 → 7.0 conversion
 * makes, for a file that already declares 7.0. Returns how many lines changed.
 */
export function upgradeExtensions(records: GedNode[], onChange: (before: string, after: string) => void = () => {}): number {
  const ctx: MigrateCtx = { changed: 0, onChange };
  for (const rec of records) if (rec.tag === "INDI") upgradeMarriedNames(rec, ctx);
  walkNodes(records, (node) => { upgradeExtensionNode(node, ctx); });
  return ctx.changed;
}

/**
 * The `TYPE` 7.0 requires on a person's or a family's generic `EVEN`/`FACT`,
 * for one that has none. An event's own text names it where it reads as a
 * name (`EVEN Graduation`: words, no digits, short): 5.5.1 programs write the
 * kind there. Anything else gets the generic `Event`. A fact's text is its
 * value (`FACT blue`), never its kind, so a fact gets `Fact`.
 */
export function eventTypeFor(node: GedNode): string {
  const text = node.value?.trim() ?? "";
  if (node.tag === "EVEN" && text.length <= 40 && /^\p{L}[\p{L} '’.-]+$/u.test(text)) return text;
  return node.tag === "EVEN" ? "Event" : "Fact";
}

/** A person's or a family's `EVEN`/`FACT` lines with no `TYPE`, each with
 *  the one {@link eventTypeFor} gives it. */
export function untypedEvents(rec: GedNode): Array<{ node: GedNode; type: string }> {
  if (rec.tag !== "INDI" && rec.tag !== "FAM") return [];
  return rec.children
    .filter((c) => (c.tag === "EVEN" || c.tag === "FACT") && !firstChild(c, "TYPE"))
    .map((node) => ({ node, type: eventTypeFor(node) }));
}

/**
 * A `NAME`'s inline `_MARNM` married surname (Gramps/PAF/Brother's Keeper,
 * MyHeritage) becomes what 7.0 says it with: a `NAME` of its own, the
 * person's given name with the married surname, `TYPE MARRIED`, right after
 * the name it hung on. Lines under the `_MARNM` (a citation, a note) go with it.
 */
function upgradeMarriedNames(indi: GedNode, ctx: MigrateCtx): void {
  for (let i = 0; i < indi.children.length; i++) {
    const name = indi.children[i];
    if (name.tag !== "NAME" || name.upgradedFrom) continue;
    const made: GedNode[] = [];
    name.children = name.children.filter((child, index) => {
      if (child.tag !== "_MARNM") return true;
      const raw = child.value?.trim() ?? "";
      // `/Kovač/` is a surname written in slashes; `Tomc/Tomec/Tometz` is a
      // list of spellings, and taking what lay between its first two slashes
      // kept "Tomec" alone.
      const surname = (raw.match(/^\/(.*)\/$/)?.[1] ?? raw).trim();
      if (!surname) return true;
      const given = (splitSlashName(name.value ?? "")?.before ?? name.value ?? "").trim();
      const before = `NAME.${describe(child)}`;
      const written = child.value;
      child.value = given ? `${given} /${surname}/` : `/${surname}/`;
      child.level = name.level;
      reindent(child.children, name.level + 1);
      child.children.unshift({ level: name.level + 1, tag: "TYPE", value: MARRIED_TYPE, children: [] });
      upgradeVendor(child, "NAME", { index, value: written });
      report(ctx, child, before);
      made.push(child);
      return false;
    });
    indi.children.splice(i + 1, 0, ...made);
    i += made.length;
  }
}

/** The way back for {@link upgradeMarriedNames}: a married `NAME` the upgrade
 *  made folds into the name before it, as the `_MARNM` it was, where it was. */
function downgradeMarriedNames(indi: GedNode, ctx: MigrateCtx): void {
  let host: GedNode | undefined;
  for (const node of [...indi.children]) {
    if (node.tag !== "NAME") continue;
    const from = node.upgradedFrom;
    if (from?.tag !== "_MARNM") {
      host = node;
      continue;
    }
    if (!host) continue;
    const before = describe(node);
    const surname = splitSlashName(node.value ?? "")?.surname ?? node.value?.trim() ?? "";
    // The surname as the file wrote it (`/Kovač/`, say), while it still is one.
    const written = from.value;
    const writtenSurname = written === undefined ? undefined : splitSlashName(written.trim().startsWith("/") ? written : `/${written}/`)?.surname;
    node.value = written !== undefined && writtenSurname === surname ? written : surname;
    node.tag = "_MARNM";
    if (from.spelling) node.spelling = from.spelling;
    delete node.upgradedFrom;
    node.children = node.children.filter((c) => !(c.tag === "TYPE" && c.value?.trim().toUpperCase() === MARRIED_TYPE));
    node.level = host.level + 1;
    reindent(node.children, host.level + 2);
    indi.children = indi.children.filter((c) => c !== node);
    host.children.splice(Math.min(from.index ?? host.children.length, host.children.length), 0, node);
    ctx.changed++;
    ctx.onChange(before, `NAME.${describe(node)}`);
  }
}

function reindent(nodes: GedNode[], level: number): void {
  for (const n of nodes) {
    n.level = level;
    reindent(n.children, level + 1);
  }
}

function upgradeRomnFone(node: GedNode, ctx: MigrateCtx): void {
  const before = describe(node);
  const typeNode = firstChild(node, "TYPE");
  const typeToken = typeNode?.value?.trim().toLowerCase();
  const fallback = node.tag === "ROMN" ? "und-Latn" : "und";
  const lang = (typeToken && TYPE_TO_LANG[typeToken]) || fallback;
  if (typeNode) {
    typeNode.tag = "LANG";
    typeNode.value = lang;
  } else {
    node.children.unshift(plain("LANG", lang));
  }
  report(ctx, retag(node, "TRAN"), before);
}

/**
 * Rewrite one 5.5.1 date value into 7.0 syntax. Phrase text moves to a
 * `PHRASE` substructure; the DATE payload keeps only what 7.0 can parse
 * (possibly nothing — an empty payload with a PHRASE is valid in 7.0).
 */
function upgradeDate(node: GedNode, ctx: MigrateCtx): void {
  const original = node.value!;
  let value = original.trim();
  let phrase: string | undefined;

  // `INT <date> (<phrase>)` → the inner date + PHRASE; `(<phrase>)` → PHRASE only.
  const int = value.match(/^INT\.?\s+(.*?)\s*\((.*)\)\s*$/i);
  const pure = value.match(/^\((.*)\)$/);
  if (int) {
    value = int[1];
    phrase = int[2];
  } else if (pure) {
    value = "";
    phrase = pure[1];
  }

  // An escape written before the qualifier (`@#DJULIAN@ ABT 1700`, against
  // 5.5.1's order) goes after it, as 7.0 writes the calendar: onto each end
  // of a range, which it was meant for.
  const lead = value.match(/^(@#D[A-Z]+(?: R)?@)\s*(ABT|CAL|EST|BEF|AFT|BET|FROM|TO)\s+(.*)$/i);
  if (lead) {
    const [, esc, qualifier, rest] = lead;
    value = `${qualifier} ${esc} ${rest.replace(/\s+(AND|TO)\s+(?!@#)/i, ` $1 ${esc} `)}`;
  }

  // Calendar escape → calendar tag prefix (GREGORIAN, being the default, drops).
  value = value.replace(/@#(D[A-Z]+(?: R)?)@\s*/gi, (m, esc: string) => {
    const cal = CALENDAR_ESCAPES[esc.toUpperCase()];
    if (!cal) return m;
    return cal === "GREGORIAN" ? "" : `${cal} `;
  });

  // Dual (Old Style/New Style) years: `1648/49` → `1649`, original kept as
  // phrase. Guarded against numeric slash dates (`1989/01/05`), which the
  // house-style date pass handles — they are not dual years. Nor is anything
  // whose second half is not the following year: `1890/12` may be a month.
  if (!/^\d{1,4}([/.-])\d{1,2}\1\d{1,4}$/.test(value)) {
    const dual = value.replace(/\b(\d{3,4})\/(\d{2})\b(?!\/)/g, (m, y: string, suffix: string) => {
      const next = Number(y) + 1;
      return next % 100 === Number(suffix) ? String(next) : m;
    });
    if (dual !== value) {
      phrase ??= value;
      value = dual;
    }
  }

  // BC era marker → BCE.
  value = value.replace(/\b(\d+)\s*(?:B\.C\.|BC\b)/gi, "$1 BCE");

  // `BET a AND b` must be chronological in 7.0 — swap endpoints when reversed.
  const bet = value.match(/^BET\s+(.+?)\s+AND\s+(.+)$/i);
  if (bet) {
    const [y1, y2] = [signedYear(bet[1]), signedYear(bet[2])];
    if (y1 !== undefined && y2 !== undefined && y1 > y2) {
      value = `BET ${bet[2]} AND ${bet[1]}`;
    }
  }

  if (value === original && phrase === undefined) return;
  const before = describe(node);
  if (value) node.value = value;
  else delete node.value;
  if (phrase !== undefined && !firstChild(node, "PHRASE")) {
    node.children.unshift(plain("PHRASE", phrase));
  }
  report(ctx, node, before);
}

/** The year an endpoint ends on — GEDCOM writes the year last — negative
 *  before the common era, so a BCE range orders by its era. */
function signedYear(datePart: string): number | undefined {
  const m = datePart.match(/(\d{1,4})(\s+BCE)?\s*$/i);
  if (!m) return undefined;
  return m[2] ? -Number(m[1]) : Number(m[1]);
}

/** 5.5.1's age keywords and the bounded 7.0 ages that say them (with the
 *  keyword, title-cased, as the age's PHRASE). */
const AGE_KEYWORDS: Record<string, string> = { CHILD: "< 8y", INFANT: "< 1y", STILLBORN: "0y" };

/** 5.5.1 age keywords → bounded 7.0 ages; normalize unit casing and bare years. */
function upgradeAge(node: GedNode, ctx: MigrateCtx): void {
  const original = node.value!;
  const keyword = original.trim().toUpperCase();
  const bounded = AGE_KEYWORDS[keyword];
  let value: string;
  if (bounded) {
    value = bounded;
  } else {
    value = original
      .trim()
      .replace(/(\d+)\s*([YMWD])/gi, (_m, n: string, u: string) => `${n}${u.toLowerCase()}`)
      .replace(/^([<>]?\s*)(\d+)$/, "$1$2y"); // bare number means years
  }
  if (value === original) return;
  const before = describe(node);
  node.value = value;
  if (bounded && !firstChild(node, "PHRASE")) {
    node.children.unshift(plain("PHRASE", titleCase(keyword)));
  }
  report(ctx, node, before);
}

function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/**
 * 5.5 let a person's `ASSO` point at a family (`TYPE FAM`): Brother's Keeper
 * and Geneanet write a wedding witness that way. 7.0's pointer names a
 * person, but a family record may carry an association of its own — so the
 * line moves to the family and points back at the person, `TYPE FAM` gone.
 * It remembers the family it named (`upgradedFrom`), which is how the
 * downgrade puts it back on the person rather than on a spouse.
 */
function upgradeFamilyAssociations(records: GedNode[], ctx: MigrateCtx): void {
  const families = new Map(records.filter((r) => r.tag === "FAM" && r.xref).map((r) => [r.xref!, r]));
  for (const indi of records) {
    if (indi.tag !== "INDI" || !indi.xref) continue;
    indi.children = indi.children.filter((assoc) => {
      const fam = assoc.tag === "ASSO" ? families.get(assoc.value?.trim() ?? "") : undefined;
      if (!fam) return true;
      const before = `INDI.${describe(assoc)}`;
      assoc.upgradedFrom = { tag: "ASSO", value: assoc.value };
      assoc.value = indi.xref;
      assoc.children = assoc.children.filter((c) => !(c.tag === "TYPE" && c.value?.trim().toUpperCase() === "FAM"));
      fam.children.push(assoc);
      report(ctx, assoc, before);
      return false;
    });
  }
}

function upgradeAsso(node: GedNode, ctx: MigrateCtx): void {
  // `TYPE` has no place under 7.0's `ASSO`. 5.5 carried it because its pointer
  // could name any record; once 5.5.1 restricted the pointer to a person, `TYPE
  // INDI` said nothing, and 7.0 dropped the tag. `TYPE FAM` stays until
  // upgradeFamilyAssociations moves the line to the family it names.
  const type = firstChild(node, "TYPE");
  if (type && type.value?.trim().toUpperCase() === "INDI") {
    node.children = node.children.filter((c) => c !== type);
    report(ctx, node, `${describe(node)}.TYPE INDI`);
  }

  const rela = firstChild(node, "RELA");
  if (!rela) return;
  const before = describe(rela);
  const text = rela.value?.trim() ?? "";
  const role = RELA_TO_ROLE[text.toLowerCase()];
  rela.tag = "ROLE";
  if (role) {
    rela.value = role;
    // "Godmother" is GODP, but GODP comes back as "godparent": the file's own
    // wording rides on the ROLE's PHRASE, which the downgrade restores.
    if (text !== ROLE_TO_RELA[role]) rela.children.unshift(plain("PHRASE", text));
  } else {
    rela.value = "OTHER";
    if (text) rela.children.unshift(plain("PHRASE", text));
  }
  report(ctx, rela, before);
}

/**
 * Bring an OBJE structure to the 7.0 shape: `FORM`/`TITL` hang under `FILE`
 * (5.5-family files often keep them at the record level), `FORM` payloads are
 * IANA media types, and the source-media kind is `MEDI` rather than `TYPE`.
 */
/**
 * 7.0 links media only by pointer, so each inline `OBJE` that holds a file
 * (5.5.1's `1 OBJE` / `2 FILE …`) moves into a media record of its own, added
 * before the trailer, and the line points to it. The record remembers it
 * (`upgradedFrom`), so converting back puts it inline again. Runs
 * after the walk, which has already hung the inline media's FORM and TITL
 * under its FILE.
 */
function extractInlineMedia(records: GedNode[], ctx: MigrateCtx): void {
  const taken = new Set(records.map((r) => r.xref).filter((x): x is string => !!x));
  let n = 0;
  const nextXref = () => {
    let x: string;
    do x = `@M${++n}@`;
    while (taken.has(x));
    taken.add(x);
    return x;
  };
  const made: GedNode[] = [];
  walkNodes(records.filter((r) => !SKIP_ROOTS.has(r.tag)), (node) => {
    // One with no FILE (a 5.5 BLOB, a title alone) goes too: 7.0 has no
    // inline form for it, and the record keeps what it says.
    if (node.tag !== "OBJE" || node.level === 0 || isPointer(node.value?.trim()) || node.children.length === 0) return;
    const rec: GedNode = { level: 0, tag: "OBJE", xref: nextXref(), children: node.children, upgradedFrom: { tag: "OBJE" } };
    reindent(rec.children, 1);
    node.value = rec.xref;
    node.children = [];
    made.push(rec);
    report(ctx, node, "OBJE (inline)");
  });
  if (!made.length) return;
  // Pushed one by one: a spread of a large file's media records would
  // overflow the call's argument limit.
  const trlr = records.findIndex((r) => r.tag === "TRLR");
  const tail = records.splice(trlr >= 0 ? trlr : records.length);
  for (const rec of made) records.push(rec);
  for (const rec of tail) records.push(rec);
}

/** The way back for {@link extractInlineMedia}: a media record it made goes
 *  back inline where its link is — when it still has just the one. */
function inlineExtractedMedia(records: GedNode[], ctx: MigrateCtx): void {
  const made = new Map(records.filter((r) => r.tag === "OBJE" && r.xref && r.upgradedFrom?.tag === "OBJE").map((r) => [r.xref!, r]));
  if (made.size === 0) return;
  const links = new Map<string, GedNode[]>();
  walkNodes(records, (node) => {
    const target = node.tag === "OBJE" && node.level > 0 ? node.value?.trim() : undefined;
    if (target && made.has(target)) links.set(target, [...(links.get(target) ?? []), node]);
  });
  const inlined = new Set<GedNode>();
  for (const [xref, [link, ...more]] of links) {
    if (more.length) continue;
    const rec = made.get(xref)!;
    link.children = [...rec.children, ...link.children];
    reindent(link.children, link.level + 1);
    delete link.value;
    inlined.add(rec);
    report(ctx, link, `OBJE ${xref}`);
  }
  // One pass over the records, not a search and a splice per record.
  if (!inlined.size) return;
  let kept = 0;
  for (const r of records) if (!inlined.has(r)) records[kept++] = r;
  records.length = kept;
}

function upgradeObje(node: GedNode, ctx: MigrateCtx): void {
  // Record-level FORM applies to every FILE; TITL goes to the first.
  for (const moved of hangMediaLinesUnderFile(node)) {
    report(ctx, moved, `OBJE-level ${describe(moved)}`);
  }
  for (const file of childrenByTag(node, "FILE")) {
    const form = firstChild(file, "FORM");
    if (!form) continue;
    const before = describe(form);
    const type = firstChild(form, "TYPE");
    // The media type is MEDI in 7.0 whatever the FORM says (a MIME type
    // already, or none at all).
    if (type) type.tag = "MEDI";
    const toMime = !!form.value && !form.value.includes("/");
    if (toMime) form.value = mimeFormOf(form.value!);
    if (type || toMime) report(ctx, form, before);
  }
}

/* ------------------------------- 7.0 → 5.5.1 ------------------------------ */

/** 7-only structures with no 5.5.1 equivalent: keep them as extension tags. */
const UNDERSCORE_DOWNGRADES: Record<string, string> = {
  UID: "_UID",
  CREA: "_CREA",
  NO: "_NO",
  SDATE: "_SDATE",
};

/** A 7.0 note's substructures, none of which 5.5.1's NOTE has. */
const NOTE_DOWNGRADES: Record<string, string> = {
  MIME: "_MIME",
  LANG: "_LANG",
  TRAN: "_TRAN",
};

/** The way back up for {@link NOTE_DOWNGRADES}. */
const NOTE_UPGRADES: Record<string, string> = Object.fromEntries(
  Object.entries(NOTE_DOWNGRADES).map(([tag, stand]) => [stand, tag]),
);

function isVoidPointer(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === VOID_XREF;
}

/**
 * 7.0's `@VOID@` pointer — "someone or something this file does not record" —
 * has no 5.5.1 form. A family link to nobody says nothing and is dropped. One
 * that names its target in a `PHRASE` becomes a note with that name, and an
 * association's note says the role too ("Ana Novak (botra)"); its other lines
 * go with it, since a reader can still find an unexpected line but not a
 * dropped one. A citation of an unrecorded source becomes 5.5.1's own form for
 * that: a text citation, described by its page, with the transcript as TEXT.
 *
 * Runs first, while an association's role is still 7.0's `ROLE`.
 */
function downgradeVoidPointers(records: GedNode[], ctx: MigrateCtx): void {
  walkNodes(records, (node) => {
    // A child's sealing must name the family (5.5.1's SLGC.FAMC is {1:1}),
    // so one to parents the file does not record has no 5.5.1 form: it goes.
    const sealings = node.children.filter((c) => c.tag === "SLGC" && childrenByTag(c, "FAMC").some((f) => isVoidPointer(f.value)));
    for (const slgc of sealings) {
      node.children = node.children.filter((c) => c !== slgc);
      ctx.changed++;
      ctx.onChange(`${node.tag}.SLGC (FAMC ${VOID_XREF})`, "—");
    }
    if (!node.children.some((c) => isVoidPointer(c.value))) return;
    const kept: GedNode[] = [];
    for (const child of node.children) {
      if (!isVoidPointer(child.value)) {
        kept.push(child);
        continue;
      }
      const before = `${node.tag}.${child.tag} ${VOID_XREF}`;
      // A repository citation with no repository record is 5.5.1's too: the
      // pointer goes, its call number stays.
      if (child.tag === "REPO") {
        delete child.value;
        kept.push(child);
        ctx.changed++;
        ctx.onChange(before, `${node.tag}.REPO`);
        continue;
      }
      const replaced = child.tag === "SOUR" ? voidCitation(child) : voidAsNote(child);
      ctx.changed++;
      ctx.onChange(before, replaced ? `${node.tag}.${describe(replaced)}` : "—");
      if (replaced) kept.push(replaced);
    }
    node.children = kept;
  });
}

/**
 * A pointer to a record the file does not hold, as a 5.5.1 note: the text that
 * says who it was (7.0's `PHRASE`; failing that, an association's own text
 * notes, which a 5.5.1 file writes for an associate it has no record of),
 * with an association's role after it. Undefined when nothing says who it was.
 * Also the health check's repair of a dangling 5.5.1 `ASSO` (fixDanglingRefs).
 */
export function voidAsNote(node: GedNode): GedNode | undefined {
  const isAsso = node.tag === "ASSO";
  let phrase = firstChild(node, "PHRASE")?.value?.trim();
  const ownNotes = !phrase && isAsso
    ? node.children.filter((c) => c.tag === "NOTE" && c.value?.trim() && !c.value.trim().startsWith("@") && !c.children.length)
    : [];
  if (ownNotes.length) phrase = ownNotes.map((c) => c.value!.trim()).join("\n");
  if (!phrase) return undefined;
  const role = isAsso ? firstChild(node, "ROLE") : undefined;
  const rela = isAsso ? firstChild(node, "RELA")?.value?.trim() : undefined;
  const roleText = (role && (firstChild(role, "PHRASE")?.value?.trim() || ROLE_TO_RELA[role.value?.trim().toUpperCase() ?? ""])) || rela;
  const note = plain("NOTE", roleText ? `${phrase} (${roleText})` : phrase);
  note.level = node.level;
  note.children = node.children.filter((c) => c.tag !== "PHRASE" && c.tag !== "ROLE" && c.tag !== "RELA" && !ownNotes.includes(c));
  return note;
}

/**
 * 5.5.1's text citation — `SOUR <description>` with no source record — is
 * 7.0's citation of a source the file does not record: `SOUR @VOID@`, the
 * description as its `PAGE` and the transcript as `DATA.TEXT`. The inverse of
 * {@link voidCitation}, so a file converted and converted back reads the same.
 */
function upgradeTextCitation(node: GedNode, ctx: MigrateCtx): void {
  const before = `SOUR ${node.value ?? ""}`.trim();
  const page = node.value?.trim() ? node.value : undefined;
  const texts = node.children.filter((c) => c.tag === "TEXT");
  const rest = node.children.filter((c) => c.tag !== "TEXT");
  node.value = VOID_XREF;
  node.children = [
    ...(page !== undefined ? [plain("PAGE", page)] : []),
    ...(texts.length ? [plain("DATA")] : []),
    ...rest,
  ];
  const data = firstChild(node, "DATA");
  if (data) data.children = texts;
  delete node.conc;
  report(ctx, node, before);
}

/** A citation of a source the file does not hold, as 5.5.1's text citation:
 *  its `PAGE` as the text, its transcript as `TEXT`. Rewrites `node` in place;
 *  undefined when neither says anything. Also the health check's repair of a
 *  dangling 5.5.1 `SOUR` (fixDanglingRefs). */
export function voidCitation(node: GedNode): GedNode | undefined {
  const page = firstChild(node, "PAGE")?.value?.trim();
  const texts = firstChild(node, "DATA")?.children.filter((c) => c.tag === "TEXT") ?? [];
  if (!page && texts.length === 0) return undefined;
  const rest = node.children.filter((c) => c.tag !== "PAGE" && c.tag !== "DATA");
  node.value = page ?? "";
  node.children = [...texts, ...rest];
  return node;
}

/**
 * 5.5.1 defines `ASSO` in one place: under an `INDI` record. Both of the other
 * places 7.0 allows have to give theirs up on the way down.
 *
 * An individual event's association goes to that person's own record — the same
 * record, one level up, which is where the dialect keeps it. A family's has no
 * family-level form to fall back on, so it goes to a spouse's record instead, the
 * husband's where the family records one and otherwise the wife's: that is what
 * 5.5.1 has to say "a witness at this couple's wedding" with. Which event it was
 * is not recoverable afterwards, and every move is named in the normalization
 * report, so the reshaping is the user's to see rather than a silent one.
 *
 * A family that records neither spouse has nowhere to send its associations, so
 * they stay where they are: an unexpected structure a reader can still find beats
 * a dropped one it cannot.
 *
 * Runs after the `ROLE` → `RELA` rewrite, on records rather than on single nodes,
 * because a move needs both containers at once.
 */
function downgradeAssoPlacement(records: GedNode[], ctx: MigrateCtx): void {
  const byXref = new Map(records.filter((r) => r.xref).map((r) => [r.xref!, r]));

  /** The `INDI` record a family's associations belong to, if it names one. */
  const spouseOf = (fam: GedNode): GedNode | undefined => {
    for (const tag of ["HUSB", "WIFE"]) {
      const ref = firstChild(fam, tag)?.value?.trim();
      const rec = ref ? byXref.get(ref) : undefined;
      if (rec?.tag === "INDI") return rec;
    }
    return undefined;
  };

  // A person's association with the family, which the upgrade moved there
  // (see upgradeFamilyAssociations), goes back to that person as it was.
  for (const fam of records) {
    if (fam.tag !== "FAM") continue;
    for (const assoc of childrenByTag(fam, "ASSO")) {
      const person = byXref.get(assoc.value?.trim() ?? "");
      if (assoc.upgradedFrom?.tag !== "ASSO" || person?.tag !== "INDI") continue;
      const before = `FAM.${describe(assoc)}`;
      fam.children = fam.children.filter((c) => c !== assoc);
      assoc.value = assoc.upgradedFrom.value;
      delete assoc.upgradedFrom;
      assoc.children.unshift({ level: assoc.level + 1, tag: "TYPE", value: "FAM", children: [] });
      person.children.push(assoc);
      ctx.changed++;
      ctx.onChange(before, `INDI.${describe(assoc)}`);
    }
  }

  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const host = rec.tag === "INDI" ? rec : spouseOf(rec);
    if (!host) continue;

    // The record's own children first (a FAM's record-level associations), then
    // each event's. Snapshot both lists: the move mutates them.
    const containers = [rec, ...rec.children.filter((c) => c.tag !== "ASSO")];
    for (const container of containers) {
      if (container === host) continue; // already where 5.5.1 wants it
      for (const assoc of childrenByTag(container, "ASSO")) {
        moveAssociation(container, host, assoc);
        ctx.changed++;
        ctx.onChange(`${container.tag}.${describe(assoc)}`, `${host.tag}.${describe(assoc)}`);
      }
    }
  }
}

function downgrade(records: GedNode[], ctx: MigrateCtx): void {
  downgradeVoidPointers(records, ctx);
  for (const rec of records) if (rec.tag === "INDI") downgradeMarriedNames(rec, ctx);
  const snoteXrefs = new Set(
    records.filter((r) => r.tag === "SNOTE" && r.xref).map((r) => r.xref!),
  );
  for (const rec of records) {
    if (rec.tag === "SNOTE" && rec.xref) {
      report(ctx, retag(rec, "NOTE"), `SNOTE ${rec.xref}`);
    }
    // 5.5.1 restricts no media record: the restriction is kept as `_RESN`,
    // its 7.0 value as written (before the enumeration pass narrows a RESN
    // list), and the upgrade restores it.
    if (rec.tag === "OBJE") {
      for (const resn of childrenByTag(rec, "RESN")) {
        const before = `OBJE.${describe(resn)}`;
        report(ctx, retag(resn, OBJE_RESN_EXTENSION), before);
      }
    }
  }

  walkNodes(records, (node) => {
    // A note is visited before its lines, so its TRAN is renamed before the
    // name-variant rewrite below could take it for a ROMN/FONE.
    if (node.tag === "NOTE" && !isPointer(node.value)) {
      for (const c of node.children) {
        if (c.tag in NOTE_DOWNGRADES) report(ctx, retag(c, NOTE_DOWNGRADES[c.tag]), `NOTE.${describe(c)}`);
      }
    }
    if (node.tag === "SNOTE" && isPointer(node.value) && snoteXrefs.has(node.value)) {
      report(ctx, retag(node, "NOTE"), `SNOTE ${node.value}`);
    } else if (node.tag === "DATE") {
      downgradeDate(node, ctx);
    } else if (node.tag === "AGE" && node.value !== undefined) {
      downgradeAge(node, ctx);
    } else if (node.tag === "TRAN" && firstChild(node, "LANG")) {
      downgradeTran(node, ctx);
    } else if (node.tag === "ASSO") {
      downgradeAsso(node, ctx);
    } else if (node.tag === "EXID" && node.level > 0) {
      downgradeExid(node, ctx);
    } else if (node.tag === "OBJE" && node.children.length > 0) {
      downgradeObje(node, ctx);
    } else if (node.tag === "SEX" && node.value?.trim().toUpperCase() === "X") {
      // 5.5.1 has no X: an "unknown" every reader accepts, with the real value
      // kept beside it for this app and for the way back up.
      const before = describe(node);
      node.value = "U";
      if (!node.children.some((c) => c.tag === SEX_X_EXTENSION)) {
        node.children.push({ level: node.level + 1, tag: SEX_X_EXTENSION, value: "X", children: [] });
      }
      report(ctx, node, before);
    } else if (node.tag === "RESI" && node.level === 1 && node.value?.trim()) {
      // 7.0's residence carries text (an address, a description); 5.5.1's
      // takes none, so the text is kept word for word as its NOTE.
      const before = describe(node);
      node.children.push({ level: node.level + 1, tag: "NOTE", value: node.value.trim(), children: [] });
      node.value = undefined;
      report(ctx, node, before);
    } else if (node.tag === "STAT" && node.level > 0) {
      migrateStat(node, ctx, "5.5.1");
    } else if (node.tag === "NAME" && node.level > 0) {
      migrateNameType(node, ctx, "5.5.1");
    } else if (node.tag in UNDERSCORE_DOWNGRADES && node.level > 0) {
      const before = describe(node);
      report(ctx, restoreVendor(node, UNDERSCORE_DOWNGRADES[node.tag]), before);
    }
  });

  // Last, because it moves whole `ASSO` subtrees between records and wants their
  // roles already rewritten when it does.
  downgradeAssoPlacement(records, ctx);
}

/** Fold a 7.0 `PHRASE` substructure back into the 5.5.1 date value, and turn
 *  calendar tags and BCE back into their 5.5.1 spellings. */
function downgradeDate(node: GedNode, ctx: MigrateCtx): void {
  const phraseNode = firstChild(node, "PHRASE");
  const original = node.value;
  let value = node.value?.trim() ?? "";

  // A calendar leads the date or follows a qualifier (`ABT JULIAN 1750`), and a
  // range names it on each end; the five keywords are no month or qualifier.
  value = value.replace(/(^|\s)(GREGORIAN|JULIAN|HEBREW|FRENCH_R)\s+/gi, (_m, lead: string, cal: string) => {
    const tag = cal.toUpperCase();
    if (tag === "GREGORIAN") return lead; // the 5.5.1 default needs no escape
    return `${lead}@#D${tag.replace("_", " ")}@ `;
  });
  value = value.replace(/\bBCE\b/gi, "B.C.");

  if (phraseNode?.value) {
    value = value ? `INT ${value} (${phraseNode.value})` : `(${phraseNode.value})`;
    node.children = node.children.filter((c) => c !== phraseNode);
  }

  if (value === (original ?? "")) return;
  const before = describe(node);
  node.value = value;
  report(ctx, node, before);
}

/** 5.5.1 ages know years/months/days only — convert 7.0 weeks to days. A
 *  bounded age whose PHRASE names the 5.5.1 keyword it says (what upgradeAge
 *  writes) is that keyword again. */
function downgradeAge(node: GedNode, ctx: MigrateCtx): void {
  const original = node.value!;
  const phrase = firstChild(node, "PHRASE");
  const keyword = phrase?.value?.trim().toUpperCase() ?? "";
  const squeeze = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  if (keyword in AGE_KEYWORDS && squeeze(AGE_KEYWORDS[keyword]) === squeeze(original)) {
    const before = describe(node);
    node.value = keyword;
    node.children = node.children.filter((c) => c !== phrase);
    report(ctx, node, before);
    return;
  }
  if (!/\d\s*w/i.test(original)) return;
  const value = original.replace(/(\d+)\s*w(?:\s+(\d+)\s*d)?/i, (_m, w: string, d?: string) => {
    return `${Number(w) * 7 + Number(d ?? 0)}d`;
  });
  if (value === original) return;
  const before = describe(node);
  node.value = value;
  report(ctx, node, before);
}

const LANG_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_TO_LANG).map(([type, lang]) => [lang.toLowerCase(), type]),
);

function downgradeTran(node: GedNode, ctx: MigrateCtx): void {
  const before = describe(node);
  const langNode = firstChild(node, "LANG")!;
  const lang = langNode.value?.trim() ?? "";
  const type = LANG_TO_TYPE[lang.toLowerCase()];
  // Latin-script transliterations are romanizations; the rest phonetic.
  const romanized = type ? type !== "kana" : /-latn\b/i.test(lang);
  langNode.tag = "TYPE";
  langNode.value = type ?? lang;
  report(ctx, retag(node, romanized ? "ROMN" : "FONE"), before);
}

function downgradeAsso(node: GedNode, ctx: MigrateCtx): void {
  const role = firstChild(node, "ROLE");
  if (!role) return;
  const before = describe(role);
  const phraseNode = firstChild(role, "PHRASE");
  const enumToken = role.value?.trim().toUpperCase() ?? "";
  role.tag = "RELA";
  role.value = phraseNode?.value || ROLE_TO_RELA[enumToken] || role.value;
  if (phraseNode) role.children = role.children.filter((c) => c !== phraseNode);
  report(ctx, role, before);
}

function downgradeExid(node: GedNode, ctx: MigrateCtx): void {
  const before = describe(node);
  const typeNode = firstChild(node, "TYPE");
  const legacyTag = typeNode?.value ? URI_TO_EXID_TAG[typeNode.value.trim()] : undefined;
  if (isFsExidType(typeNode?.value)) {
    // A FamilySearch person id: 5.5.1 files carry those in the vendor tag
    // the app reads as one (and the upgrade turns back into this EXID).
    node.children = node.children.filter((c) => c !== typeNode);
    const own = node.upgradedFrom && FS_VENDOR_TAGS.includes(node.upgradedFrom.tag);
    report(ctx, restoreVendor(node, own ? node.upgradedFrom!.tag : "_FSFTID"), before);
  } else if (legacyTag) {
    node.children = node.children.filter((c) => c !== typeNode);
    report(ctx, retag(node, legacyTag), before);
  } else {
    // No 5.5.1 identifier matches — REFN with the type kept is the closest fit.
    report(ctx, retag(node, "REFN"), before);
  }
}

/** Retag a standard line to its 5.5.1 extension tag, in the spelling the
 *  file had when the upgrade made it from one. */
function restoreVendor(node: GedNode, tag: string): GedNode {
  const from = node.upgradedFrom;
  delete node.upgradedFrom;
  node.tag = tag;
  if (from?.tag === tag && from.spelling) node.spelling = from.spelling;
  return node;
}

function downgradeObje(node: GedNode, ctx: MigrateCtx): void {
  for (const file of childrenByTag(node, "FILE")) {
    const form = firstChild(file, "FORM");
    if (!form) continue;
    const before = describe(form);
    const medi = firstChild(form, "MEDI");
    // The media type is TYPE in 5.5.1 whatever the FORM says.
    if (medi) medi.tag = "TYPE";
    const fromMime = !!form.value?.includes("/");
    if (fromMime) {
      const ext = MIME_TO_EXT[form.value!.trim().toLowerCase()];
      form.value = ext ?? form.value!.split("/").pop()!.replace(/^x-/i, "");
    }
    if (medi || fromMime) report(ctx, form, before);
  }
}
