import type { GedcomVersion, GedNode } from "../gedcom/types";
import { RELA_TO_ROLE, ROLE_TO_RELA, VOID_XREF } from "../gedcom/assoc";
import { firstChild, childrenByTag } from "../gedcom/node";
import { moveAssociation } from "../gedcom/edit";
import { hangMediaLinesUnderFile, MIME_TO_EXT, mimeFormOf } from "../gedcom/mediaForm";
import { readSex, SEX_X_EXTENSION } from "../gedcom/sex";
import { NAME_TYPES_551, nameType70, splitSlashName } from "../gedcom/name";
import { FS_EXID_TYPE, FS_VENDOR_TAGS, isFsExidType } from "../gedcom/exid";
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
 *  - 7-only structures on downgrade    : `UID` → `_UID`, `CREA` → `_CREA`,
 *                                        `NO` → `_NO`, `SDATE` → `_SDATE` (all
 *                                        but `_CREA` restored on the way up), a
 *                                        note's `MIME`/`LANG`/`TRAN` → `_…`,
 *                                        `@VOID@` pointers (see below),
 *                                        `SEX X` → `SEX U` + `_SEX X` (and back)
 *
 * A vendor line the upgrade turns into its standard form remembers what it was
 * (`GedNode.upgradedFrom`), so the downgrade gives back that very line — `_FID`
 * rather than the `_FSFTID` it writes for a FamilySearch EXID the file had of
 * its own, and the `_MARNM` rather than the married `NAME` (valid 5.5.1 too).
 *
 * Not attempted (would create new records rather than rewrite in place):
 * extracting inline `OBJE`/text `SOUR` substructures into pointed records.
 */

/** The two spec families migration distinguishes. An `unknown` declared
 *  version is treated as legacy 5.5.x, matching the serializer's convention. */
export type VersionFamily = "5.5.1" | "7.0";

export function versionFamily(v: GedcomVersion): VersionFamily {
  return v === "7.0" ? "7.0" : "5.5.1";
}

/** Roots whose substructures are never merged into the main file. */
const SKIP_ROOTS = new Set(["HEAD", "TRLR", "SUBM", "SUBN"]);

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
  const ctx: MigrateCtx = { changed: 0, onChange };
  const migratable = records.filter((r) => !SKIP_ROOTS.has(r.tag));
  if (to === "7.0") upgrade(migratable, ctx);
  else downgrade(migratable, ctx);
  return ctx.changed;
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

  walkNodes(records, (node) => {
    if (upgradeExtensionNode(node, ctx)) return;
    if (node.tag === "NOTE" && isPointer(node.value) && noteXrefs.has(node.value)) {
      report(ctx, retag(node, "SNOTE"), `NOTE ${node.value}`);
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
    } else if (node.tag === "PEDI" && node.value !== undefined) {
      const upper = node.value.trim().toUpperCase();
      if (upper !== node.value && ["ADOPTED", "BIRTH", "FOSTER", "SEALING"].includes(upper)) {
        const before = describe(node);
        node.value = upper;
        report(ctx, node, before);
      }
    }
  });
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
      const surname = (raw.match(/\/([^/]*)\//)?.[1] ?? raw).trim();
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
    node.value = written !== undefined && (written.match(/\/([^/]*)\//)?.[1] ?? written).trim() === surname ? written : surname;
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

/** 5.5.1 age keywords → bounded 7.0 ages; normalize unit casing and bare years. */
function upgradeAge(node: GedNode, ctx: MigrateCtx): void {
  const original = node.value!;
  const keyword = original.trim().toUpperCase();
  const bounded = { CHILD: "< 8y", INFANT: "< 1y", STILLBORN: "0y" }[keyword];
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

function upgradeAsso(node: GedNode, ctx: MigrateCtx): void {
  // `TYPE` has no place under 7.0's `ASSO`. 5.5 carried it because its pointer
  // could name any record; once 5.5.1 restricted the pointer to a person, `TYPE
  // INDI` said nothing, and 7.0 dropped the tag. `TYPE FAM` is left where it is:
  // its pointer is one 7.0 cannot express either, and the tag is the only line
  // saying the association does not name a person.
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
function upgradeObje(node: GedNode, ctx: MigrateCtx): void {
  // Record-level FORM applies to every FILE; TITL goes to the first.
  for (const moved of hangMediaLinesUnderFile(node)) {
    report(ctx, moved, `OBJE-level ${describe(moved)}`);
  }
  for (const file of childrenByTag(node, "FILE")) {
    const form = firstChild(file, "FORM");
    if (!form?.value || form.value.includes("/")) continue;
    const before = describe(form);
    form.value = mimeFormOf(form.value);
    const type = firstChild(form, "TYPE");
    if (type) type.tag = "MEDI";
    report(ctx, form, before);
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

function voidAsNote(node: GedNode): GedNode | undefined {
  const phrase = firstChild(node, "PHRASE")?.value?.trim();
  if (!phrase) return undefined;
  const role = node.tag === "ASSO" ? firstChild(node, "ROLE") : undefined;
  const roleText = role && (firstChild(role, "PHRASE")?.value?.trim() || ROLE_TO_RELA[role.value?.trim().toUpperCase() ?? ""]);
  const note = plain("NOTE", roleText ? `${phrase} (${roleText})` : phrase);
  note.level = node.level;
  note.children = node.children.filter((c) => c.tag !== "PHRASE" && c.tag !== "ROLE");
  return note;
}

function voidCitation(node: GedNode): GedNode | undefined {
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

/** 5.5.1 ages know years/months/days only — convert 7.0 weeks to days. */
function downgradeAge(node: GedNode, ctx: MigrateCtx): void {
  const original = node.value!;
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
    if (!form?.value?.includes("/")) continue;
    const before = describe(form);
    const ext = MIME_TO_EXT[form.value.trim().toLowerCase()];
    form.value = ext ?? form.value.split("/").pop()!.replace(/^x-/i, "");
    const medi = firstChild(form, "MEDI");
    if (medi) medi.tag = "TYPE";
    report(ctx, form, before);
  }
}
