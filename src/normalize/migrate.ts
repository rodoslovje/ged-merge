import type { GedcomVersion, GedNode } from "../gedcom/types";
import { cloneNode, firstChild } from "../gedcom/node";
import { EXT_TO_MIME, MIME_TO_EXT } from "../gedcom/mediaForm";
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
 *                                        (+ `PHRASE` for OTHER)
 *  - identifiers                       : `AFN`/`RFN`/`RIN` ⇄ `EXID` + TYPE URI
 *                                        (other EXIDs downgrade to `REFN`)
 *  - media                             : `FORM` file extension ⇄ IANA media
 *                                        type, record-level `FORM`/`TITL`
 *                                        moved under `FILE`, `TYPE` ⇄ `MEDI`
 *  - 7-only structures on downgrade    : `UID` → `_UID`, `CREA` → `_CREA`,
 *                                        `NO` → `_NO`, `SEX X` → `U`
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

/** Free-text ASSO `RELA` → GEDCOM 7 `ROLE` enum (English + Slovenian terms). */
const RELA_TO_ROLE: Record<string, string> = {
  child: "CHIL",
  clergy: "CLERGY",
  priest: "CLERGY",
  duhovnik: "CLERGY",
  father: "FATH",
  friend: "FRIEND",
  prijatelj: "FRIEND",
  godparent: "GODP",
  godfather: "GODP",
  godmother: "GODP",
  boter: "GODP",
  botra: "GODP",
  husband: "HUSB",
  mother: "MOTH",
  neighbor: "NGHBR",
  neighbour: "NGHBR",
  sosed: "NGHBR",
  officiator: "OFFICIATOR",
  parent: "PARENT",
  spouse: "SPOU",
  wife: "WIFE",
  witness: "WITN",
  "priča": "WITN",
  prica: "WITN",
};

const ROLE_TO_RELA: Record<string, string> = {
  CHIL: "child",
  CLERGY: "clergy",
  FATH: "father",
  FRIEND: "friend",
  GODP: "godparent",
  HUSB: "husband",
  MOTH: "mother",
  MULTIPLE: "multiple birth",
  NGHBR: "neighbor",
  OFFICIATOR: "officiator",
  PARENT: "parent",
  SPOU: "spouse",
  WIFE: "wife",
  WITN: "witness",
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

  walkNodes(records, (node) => {
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
    } else if (node.tag === "OBJE" && node.children.length > 0) {
      upgradeObje(node, ctx);
    } else if (node.tag === "SEX" && node.value !== undefined) {
      const letter = { MALE: "M", FEMALE: "F", UNKNOWN: "U" }[node.value.trim().toUpperCase()];
      if (letter && node.value !== letter) {
        const before = describe(node);
        node.value = letter;
        report(ctx, node, before);
      }
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
  value = value.replace(/@#(D[A-Z]+(?: R)?)@\s*/i, (m, esc: string) => {
    const cal = CALENDAR_ESCAPES[esc.toUpperCase()];
    if (!cal) return m;
    return cal === "GREGORIAN" ? "" : `${cal} `;
  });

  // Dual (Old Style/New Style) years: `1648/49` → `1649`, original kept as
  // phrase. Guarded against numeric slash dates (`1989/01/05`), which the
  // house-style date pass handles — they are not dual years.
  if (!/^\d{1,4}([/.-])\d{1,2}\1\d{1,4}$/.test(value)) {
    const dual = value.replace(/\b(\d{3,4})\/(\d{2})\b(?!\/)/g, (_m, y: string, suffix: string) => {
      const year = Number(y);
      let next = Math.floor(year / 100) * 100 + Number(suffix);
      if (next <= year) next += 100;
      return String(next);
    });
    if (dual !== value) {
      phrase ??= value;
      value = dual;
    }
  }

  // BC era marker → BCE.
  value = value.replace(/\b(\d+)\s*(?:B\.C\.|BC\b)/i, "$1 BCE");

  // `BET a AND b` must be chronological in 7.0 — swap endpoints when reversed.
  const bet = value.match(/^BET\s+(.+?)\s+AND\s+(.+)$/i);
  if (bet) {
    const [y1, y2] = [lastYear(bet[1]), lastYear(bet[2])];
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

function lastYear(datePart: string): number | undefined {
  const years = datePart.match(/\d{3,4}/g);
  return years ? Number(years[years.length - 1]) : undefined;
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
  const rela = firstChild(node, "RELA");
  if (!rela) return;
  const before = describe(rela);
  const text = rela.value?.trim() ?? "";
  const role = RELA_TO_ROLE[text.toLowerCase()];
  rela.tag = "ROLE";
  if (role) {
    rela.value = role;
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
  const files = node.children.filter((c) => c.tag === "FILE");
  if (files.length > 0) {
    // Record-level FORM applies to every FILE; TITL goes to the first.
    for (const stray of node.children.filter((c) => c.tag === "FORM")) {
      node.children = node.children.filter((c) => c !== stray);
      files.forEach((file, i) => {
        if (firstChild(file, "FORM")) return;
        file.children.push(i === 0 ? stray : cloneNode(stray));
      });
      report(ctx, stray, `OBJE-level FORM ${stray.value ?? ""}`.trim());
    }
    const titl = firstChild(node, "TITL");
    if (titl && !firstChild(files[0], "TITL")) {
      node.children = node.children.filter((c) => c !== titl);
      files[0].children.push(titl);
      report(ctx, titl, `OBJE-level ${describe(titl)}`);
    }
  }
  for (const file of files) {
    const form = firstChild(file, "FORM");
    if (!form?.value || form.value.includes("/")) continue;
    const before = describe(form);
    form.value = EXT_TO_MIME[form.value.trim().toLowerCase()] ?? "application/octet-stream";
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
};

function downgrade(records: GedNode[], ctx: MigrateCtx): void {
  const snoteXrefs = new Set(
    records.filter((r) => r.tag === "SNOTE" && r.xref).map((r) => r.xref!),
  );
  for (const rec of records) {
    if (rec.tag === "SNOTE" && rec.xref) {
      report(ctx, retag(rec, "NOTE"), `SNOTE ${rec.xref}`);
    }
  }

  walkNodes(records, (node) => {
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
      const before = describe(node);
      node.value = "U";
      report(ctx, node, before);
    } else if (node.tag in UNDERSCORE_DOWNGRADES && node.level > 0) {
      report(ctx, retag(node, UNDERSCORE_DOWNGRADES[node.tag]), describe(node));
    }
  });
}

/** Fold a 7.0 `PHRASE` substructure back into the 5.5.1 date value, and turn
 *  calendar tags and BCE back into their 5.5.1 spellings. */
function downgradeDate(node: GedNode, ctx: MigrateCtx): void {
  const phraseNode = firstChild(node, "PHRASE");
  const original = node.value;
  let value = node.value?.trim() ?? "";

  value = value.replace(/^(GREGORIAN|JULIAN|HEBREW|FRENCH_R)\s+/i, (_m, cal: string) => {
    const tag = cal.toUpperCase();
    if (tag === "GREGORIAN") return ""; // the 5.5.1 default needs no escape
    return `@#D${tag.replace("_", " ")}@ `;
  });
  value = value.replace(/\bBCE\b/i, "B.C.");

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
  if (legacyTag) {
    node.children = node.children.filter((c) => c !== typeNode);
    report(ctx, retag(node, legacyTag), before);
  } else {
    // No 5.5.1 identifier matches — REFN with the type kept is the closest fit.
    report(ctx, retag(node, "REFN"), before);
  }
}

function downgradeObje(node: GedNode, ctx: MigrateCtx): void {
  for (const file of node.children.filter((c) => c.tag === "FILE")) {
    const form = firstChild(file, "FORM");
    if (!form?.value?.includes("/")) continue;
    const before = describe(form);
    const ext = MIME_TO_EXT[form.value.trim().toLowerCase()];
    form.value = ext ?? form.value.split("/").pop()!;
    const medi = firstChild(form, "MEDI");
    if (medi) medi.tag = "TYPE";
    report(ctx, form, before);
  }
}
