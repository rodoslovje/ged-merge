import { buildDataset } from "../gedcom/builder";
import { parseDate } from "../gedcom/date";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";

/**
 * Import for the "matches" CSV exported by a genealogical index site such as
 * indeks.rodoslovje.si (the Slovenian Genealogical Index): a list of person
 * pairs, two rows per match — the first row is the person as recorded by the
 * master tree's own contributor, the second is the corresponding record from
 * another source (e.g. a cemetery index). We resolve the first row against
 * the master dataset by exact name + birth year, and present the second row
 * as a synthetic "incoming" individual for review/merge.
 *
 * The site's column headers are translated per UI language; `COLUMN_SETS`
 * lists the translations we know about so a CSV exported in any of those
 * languages is recognised. Date values themselves are always GEDCOM-style
 * (English month abbreviations) regardless of UI language.
 */

/** Per-language column header translations for the simple 1:1 fields. */
interface ColumnSet {
  given: string;
  surname: string;
  birthDate: string;
  birthPlace: string;
  deathDate: string;
  deathPlace: string;
  burialDate: string;
  burialPlace: string;
  links: string;
  partners: string;
  /** Combined parents column (older export format), e.g. "Starši" / "Parents". */
  parents: string;
  genealogist: string;
  confidence: string;
}

/** Column header sets for languages supported by indeks.rodoslovje.si. */
const COLUMN_SETS: Record<string, ColumnSet> = {
  sl: {
    given: "Ime",
    surname: "Priimek",
    birthDate: "Datum rojstva",
    birthPlace: "Kraj rojstva",
    deathDate: "Datum smrti",
    deathPlace: "Kraj smrti",
    burialDate: "Datum pokopa",
    burialPlace: "Kraj pokopa",
    links: "Povezave",
    partners: "Partnerji",
    parents: "Starši",
    genealogist: "Rodoslovec",
    confidence: "Zaupanje",
  },
  en: {
    given: "Name",
    surname: "Surname",
    birthDate: "Date of Birth",
    birthPlace: "Place of Birth",
    deathDate: "Date of Death",
    deathPlace: "Place of Death",
    burialDate: "Burial date",
    burialPlace: "Burial place",
    links: "Links",
    partners: "Partners",
    parents: "Parents",
    genealogist: "Genealogist",
    confidence: "Confidence",
  },
  de: {
    given: "Vorname",
    surname: "Nachname",
    birthDate: "Geburtsdatum",
    birthPlace: "Geburtsort",
    deathDate: "Sterbedatum",
    deathPlace: "Sterbeort",
    burialDate: "Datum der Beerdigung",
    burialPlace: "Ort der Beerdigung",
    links: "Links",
    partners: "Partner",
    parents: "Eltern",
    genealogist: "Genealoge",
    confidence: "Konfidenz",
  },
  hr: {
    given: "Ime",
    surname: "Prezime",
    birthDate: "Datum rođenja",
    birthPlace: "Mjesto rođenja",
    deathDate: "Datum smrti",
    deathPlace: "Mjesto smrti",
    burialDate: "Datum pokopa",
    burialPlace: "Mjesto pokopa",
    links: "Poveznice",
    partners: "Partneri",
    parents: "Roditelji",
    genealogist: "Rodoslovac",
    confidence: "Pouzdanost",
  },
  hu: {
    given: "Utónév",
    surname: "Vezetéknév",
    birthDate: "Születési dátum",
    birthPlace: "Születési hely",
    deathDate: "Halál dátuma",
    deathPlace: "Halál helye",
    burialDate: "Temetés dátuma",
    burialPlace: "Temetés helye",
    links: "Hivatkozások",
    partners: "Partnerek",
    parents: "Szülők",
    genealogist: "Genealógus",
    confidence: "Megbízhatóság",
  },
  it: {
    given: "Nome",
    surname: "Cognome",
    birthDate: "Data di nascita",
    birthPlace: "Luogo di nascita",
    deathDate: "Data di morte",
    deathPlace: "Luogo di morte",
    burialDate: "Data di sepoltura",
    burialPlace: "Luogo di sepoltura",
    links: "Collegamenti",
    partners: "Partner",
    parents: "Genitori",
    genealogist: "Genealogista",
    confidence: "Confidenza",
  },
};

/**
 * "Father" / "Mother" columns (newer export format, replacing the combined
 * "parents" column) are only known in English so far — not yet translated
 * for the other UI languages.
 */
const FATHER_COLUMN = "Father";
const MOTHER_COLUMN = "Mother";

/** Prefix for the synthetic individual IDs produced from this import. */
const ID_PREFIX = "SGI";

/** The master-side identity used to find the corresponding individual. */
export interface GiMasterKey {
  given: string;
  surname: string;
  birthYear?: number;
}

/** One CSV match pair: the master-side key plus the synthetic compare individual it produced. */
export interface GiPair {
  masterKey: GiMasterKey;
  compareId: string;
}

export interface GiMatchesImport {
  dataset: Dataset;
  pairs: GiPair[];
}

/** Parse RFC4180-ish CSV text (quoted fields, embedded commas/newlines/quotes). */
export function parseCsvText(text: string): string[][] {
  // Strip a leading UTF-8 BOM.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Final field/row (files without a trailing newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A place/date cell that's actually a free-text annotation, not real data. */
function isAnnotation(value: string): boolean {
  return value.includes("🗒");
}

/** Column fields every export includes, regardless of which "parents" shape it uses. */
type RequiredField = Exclude<keyof ColumnSet, "parents">;

/** Resolved column layout for one CSV: which header row index has which field. */
interface ColumnLayout {
  index: Record<RequiredField, number>;
  /** Combined "Starši"/"Parents"/etc. column (older export format), when present. */
  parentsIndex?: number;
  fatherIndex?: number;
  motherIndex?: number;
}

/** Match the header row against each known language's column set. */
function detectColumns(header: string[]): ColumnLayout | undefined {
  for (const columns of Object.values(COLUMN_SETS)) {
    const index: Partial<Record<RequiredField, number>> = {};
    let ok = true;
    for (const [field, name] of Object.entries(columns) as [keyof ColumnSet, string][]) {
      if (field === "parents") continue;
      const idx = header.indexOf(name);
      if (idx < 0) {
        ok = false;
        break;
      }
      index[field as RequiredField] = idx;
    }
    if (!ok) continue;

    const parentsIndex = header.indexOf(columns.parents);
    const fatherIndex = header.indexOf(FATHER_COLUMN);
    const motherIndex = header.indexOf(MOTHER_COLUMN);
    return {
      index: index as Record<RequiredField, number>,
      parentsIndex: parentsIndex >= 0 ? parentsIndex : undefined,
      fatherIndex: fatherIndex >= 0 ? fatherIndex : undefined,
      motherIndex: motherIndex >= 0 ? motherIndex : undefined,
    };
  }
  return undefined;
}

/**
 * Column header set for the "family matches" CSV: pairs of rows describing a
 * couple (husband + wife) rather than a single person. Only known in English
 * so far — not yet translated for the other UI languages.
 */
interface FamilyColumnSet {
  husbandName: string;
  husbandSurname: string;
  husbandBirth: string;
  wifeName: string;
  wifeSurname: string;
  wifeBirth: string;
  marriageDate: string;
  marriagePlace: string;
  links: string;
  children: string;
  husbandFather: string;
  husbandMother: string;
  wifeFather: string;
  wifeMother: string;
  genealogist: string;
}

type FamilyField = keyof FamilyColumnSet;

const FAMILY_COLUMNS: FamilyColumnSet = {
  husbandName: "Husband Name",
  husbandSurname: "Husband Surname",
  husbandBirth: "Husband Birth",
  wifeName: "Wife Name",
  wifeSurname: "Wife Surname",
  wifeBirth: "Wife Birth",
  marriageDate: "Date of Marriage",
  marriagePlace: "Place of Marriage",
  links: "Links",
  children: "Children",
  husbandFather: "Husband's Father",
  husbandMother: "Husband's Mother",
  wifeFather: "Wife's Father",
  wifeMother: "Wife's Mother",
  genealogist: "Genealogist",
};

/** Match the header row against the family matches column set. */
function detectFamilyColumns(header: string[]): Record<FamilyField, number> | undefined {
  const index: Partial<Record<FamilyField, number>> = {};
  for (const [field, name] of Object.entries(FAMILY_COLUMNS) as [FamilyField, string][]) {
    const idx = header.indexOf(name);
    if (idx < 0) return undefined;
    index[field] = idx;
  }
  return index as Record<FamilyField, number>;
}

/**
 * Parse a genealogical index matches CSV into a synthetic compare `Dataset`
 * plus the master-side keys needed to resolve each pair to a master
 * individual. Two CSV shapes are recognised: per-person matches (one
 * individual per pair) and per-family matches (one couple per pair, yielding
 * up to two pairs — husband and wife).
 *
 * Throws if the header doesn't match either known shape.
 */
export function parseGiMatchesCsv(text: string): GiMatchesImport {
  const rows = parseCsvText(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) throw new Error("Empty CSV file");

  const header = rows[0];
  // Trailing metadata rows (source/date/search footer) have a different
  // column count than the header and are ignored.
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);

  const layout = detectColumns(header);
  if (layout) return parsePersonMatches(dataRows, layout);

  const familyIndex = detectFamilyColumns(header);
  if (familyIndex) return parseFamilyMatches(dataRows, familyIndex);

  throw new Error("Unrecognized matches CSV: unknown column headers");
}

function finish(records: GedNode[], pairs: GiPair[]): GiMatchesImport {
  const parsed: ParseResult = {
    version: "5.5.1",
    charset: "UTF-8",
    records,
    warnings: [],
    eol: "\n",
    finalNewline: true,
  };
  return { dataset: buildDataset(parsed), pairs };
}

function parsePersonMatches(dataRows: string[][], layout: ColumnLayout): GiMatchesImport {
  const col = (row: string[], field: RequiredField): string => (row[layout.index[field]] ?? "").trim();
  const colAt = (row: string[], idx: number | undefined): string =>
    idx === undefined ? "" : (row[idx] ?? "").trim();

  const records: GedNode[] = [];
  const pairs: GiPair[] = [];
  let n = 0;
  for (let i = 0; i + 1 < dataRows.length; i += 2) {
    const masterRow = dataRows[i];
    const incomingRow = dataRows[i + 1];

    const masterKey: GiMasterKey = {
      given: col(masterRow, "given"),
      surname: col(masterRow, "surname"),
      birthYear: parseDate(col(masterRow, "birthDate")).year,
    };
    if (!masterKey.given || !masterKey.surname) continue;

    n++;
    const compareId = `@${ID_PREFIX}${n}@`;
    records.push(...buildPairRecords(n, incomingRow, col, colAt, layout));
    pairs.push({ masterKey, compareId });
  }

  return finish(records, pairs);
}

/** One parent/partner parsed from a "Father"/"Mother"/"Partners"/"Parents" cell. */
interface RelativeEntry {
  name: string;
  date?: string;
  /** Role relative to the main individual, when the source text says so (older "Partnerji" format). */
  role?: "husband" | "wife";
}

/**
 * Parse a "Father"/"Mother"/"Partners"/combined "Parents" cell into a list of
 * relatives. Newer exports use "Name | date" entries separated by ";";
 * older exports use "Name *year" entries (optionally prefixed with
 * "Žena:"/"Mož:"/"Wife:"/"Husband:" for partners) separated by ",".
 * "<private>" entries are dropped since they carry no name.
 */
function parseRelativeList(value: string): RelativeEntry[] {
  if (!value) return [];
  const parts = value.includes("|") ? value.split(";") : value.split(",");
  const out: RelativeEntry[] = [];
  for (let part of parts) {
    part = part.trim();
    if (!part || part === "<private>") continue;

    let role: "husband" | "wife" | undefined;
    const roleMatch = part.match(/^(Žena|Mož|Wife|Husband):\s*/i);
    if (roleMatch) {
      role = /žena|wife/i.test(roleMatch[1]) ? "wife" : "husband";
      part = part.slice(roleMatch[0].length).trim();
    }

    let name = part;
    let date: string | undefined;
    if (part.includes("|")) {
      const [n, d] = part.split("|");
      name = n.trim();
      date = d?.trim();
    } else {
      const m = part.match(/^(.*?)\s*\*\s*(.+)$/);
      if (m) {
        name = m[1].trim();
        date = m[2].trim();
      }
    }
    if (name) out.push({ name, date, role });
  }
  return out;
}

/** Split a "Given Surname" string into NAME parts (last word = surname). */
function splitName(full: string): { given: string; surname: string } {
  const idx = full.lastIndexOf(" ");
  if (idx < 0) return { given: full, surname: "" };
  return { given: full.slice(0, idx).trim(), surname: full.slice(idx + 1).trim() };
}

/** Build a synthetic INDI record for a relative parsed from a "Name | date" cell. */
function buildRelativeIndi(xref: string, entry: RelativeEntry, famId: string, pointerTag: "FAMS" | "FAMC" = "FAMS"): GedNode {
  const { given, surname } = splitName(entry.name);
  const children: GedNode[] = [node(1, "NAME", `${given} /${surname}/`)];
  if (entry.date && !isAnnotation(entry.date)) {
    children.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", entry.date)] });
  }
  children.push(node(1, pointerTag, famId));
  return { level: 0, xref, tag: "INDI", children };
}

function famNode(xref: string, children: GedNode[]): GedNode {
  return { level: 0, xref, tag: "FAM", children };
}

/**
 * Build a synthetic parents FAM (father=HUSB, mother=WIFE, `childId`=CHIL)
 * plus INDI records for whichever of father/mother are present, and the FAMC
 * pointer to add to the child's INDI record. Returns no records if neither
 * parent is present.
 */
function buildParentsRecords(
  idPrefix: string,
  childId: string,
  father: RelativeEntry | undefined,
  mother: RelativeEntry | undefined,
): { records: GedNode[]; famc?: GedNode } {
  if (!father && !mother) return { records: [] };

  const famId = `${idPrefix}FAM@`;
  const records: GedNode[] = [];
  const famChildren: GedNode[] = [];
  if (father) {
    const id = `${idPrefix}F@`;
    records.push(buildRelativeIndi(id, father, famId));
    famChildren.push(node(1, "HUSB", id));
  }
  if (mother) {
    const id = `${idPrefix}M@`;
    records.push(buildRelativeIndi(id, mother, famId));
    famChildren.push(node(1, "WIFE", id));
  }
  famChildren.push(node(1, "CHIL", childId));
  records.push(famNode(famId, famChildren));
  return { records, famc: node(1, "FAMC", famId) };
}

/**
 * Build the synthetic INDI record for one pair's incoming individual, plus
 * any synthetic INDI/FAM records needed to represent its parents and
 * partners as real family relationships.
 */
function buildPairRecords(
  n: number,
  row: string[],
  col: (row: string[], field: RequiredField) => string,
  colAt: (row: string[], idx: number | undefined) => string,
  layout: ColumnLayout,
): GedNode[] {
  const compareId = `@${ID_PREFIX}${n}@`;
  const indiChildren: GedNode[] = [];
  const records: GedNode[] = [];

  const given = col(row, "given");
  const surname = col(row, "surname");
  indiChildren.push(node(1, "NAME", `${given} /${surname}/`));

  pushEvent(indiChildren, "BIRT", col(row, "birthDate"), col(row, "birthPlace"));
  pushEvent(indiChildren, "DEAT", col(row, "deathDate"), col(row, "deathPlace"));
  pushEvent(indiChildren, "BURI", col(row, "burialDate"), col(row, "burialPlace"));

  for (const url of col(row, "links").split(",").map((s) => s.trim()).filter(Boolean)) {
    indiChildren.push(node(1, "WWW", url));
  }

  // Parents: separate Father/Mother columns (newer format) take priority over
  // the combined "Parents"/"Starši" column (older format: father then mother).
  let father = parseRelativeList(colAt(row, layout.fatherIndex))[0];
  let mother = parseRelativeList(colAt(row, layout.motherIndex))[0];
  if (!father && !mother) {
    const parents = parseRelativeList(colAt(row, layout.parentsIndex));
    father = parents[0];
    mother = parents[1];
  }
  const parents = buildParentsRecords(`@${ID_PREFIX}${n}`, compareId, father, mother);
  records.push(...parents.records);
  if (parents.famc) indiChildren.push(parents.famc);

  // Partners: each entry becomes its own family shared with the main individual.
  const partners = parseRelativeList(col(row, "partners"));
  partners.forEach((partner, i) => {
    const partnerId = `@${ID_PREFIX}${n}P${i + 1}@`;
    const famId = `@${ID_PREFIX}${n}PFAM${i + 1}@`;
    const mainIsWife = partner.role === "husband";
    const famChildren = mainIsWife
      ? [node(1, "HUSB", partnerId), node(1, "WIFE", compareId)]
      : [node(1, "HUSB", compareId), node(1, "WIFE", partnerId)];
    records.push(buildRelativeIndi(partnerId, partner, famId));
    records.push(famNode(famId, famChildren));
    indiChildren.push(node(1, "FAMS", famId));
  });

  records.unshift({ level: 0, xref: compareId, tag: "INDI", children: indiChildren });
  return records;
}

/** Push a dated/placed event node, omitting it entirely when both are empty/annotations. */
function pushEvent(into: GedNode[], tag: string, date: string, place: string): void {
  const children: GedNode[] = [];
  if (date && !isAnnotation(date)) children.push(node(2, "DATE", date));
  if (place && !isAnnotation(place)) children.push(node(2, "PLAC", place));
  if (children.length) into.push({ level: 1, tag, children });
}

function node(level: number, tag: string, value: string): GedNode {
  return { level, tag, value, children: [] };
}

function parseFamilyMatches(dataRows: string[][], index: Record<FamilyField, number>): GiMatchesImport {
  const col = (row: string[], field: FamilyField): string => (row[index[field]] ?? "").trim();

  const records: GedNode[] = [];
  const pairs: GiPair[] = [];
  let n = 0;
  for (let i = 0; i + 1 < dataRows.length; i += 2) {
    const masterRow = dataRows[i];
    const incomingRow = dataRows[i + 1];

    const husbandKey: GiMasterKey = {
      given: col(masterRow, "husbandName"),
      surname: col(masterRow, "husbandSurname"),
      birthYear: parseDate(col(masterRow, "husbandBirth")).year,
    };
    const wifeKey: GiMasterKey = {
      given: col(masterRow, "wifeName"),
      surname: col(masterRow, "wifeSurname"),
      birthYear: parseDate(col(masterRow, "wifeBirth")).year,
    };
    if (!husbandKey.given && !husbandKey.surname && !wifeKey.given && !wifeKey.surname) continue;

    n++;
    const husbandId = `@${ID_PREFIX}${n}H@`;
    const wifeId = `@${ID_PREFIX}${n}W@`;
    records.push(...buildFamilyRecords(n, incomingRow, col, husbandId, wifeId));

    if (husbandKey.given || husbandKey.surname) pairs.push({ masterKey: husbandKey, compareId: husbandId });
    if (wifeKey.given || wifeKey.surname) pairs.push({ masterKey: wifeKey, compareId: wifeId });
  }

  return finish(records, pairs);
}

/**
 * Build the synthetic FAM record for one couple, plus INDI records for the
 * husband and wife (with their parent families and a source note), and any
 * children listed in the "Children" column.
 */
function buildFamilyRecords(
  n: number,
  row: string[],
  col: (row: string[], field: FamilyField) => string,
  husbandId: string,
  wifeId: string,
): GedNode[] {
  const records: GedNode[] = [];
  const famId = `@${ID_PREFIX}${n}FAM@`;

  const husbandChildren: GedNode[] = [node(1, "NAME", `${col(row, "husbandName")} /${col(row, "husbandSurname")}/`)];
  pushEvent(husbandChildren, "BIRT", col(row, "husbandBirth"), "");
  husbandChildren.push(node(1, "FAMS", famId));
  const husbandParents = buildParentsRecords(
    `@${ID_PREFIX}${n}H`,
    husbandId,
    parseRelativeList(col(row, "husbandFather"))[0],
    parseRelativeList(col(row, "husbandMother"))[0],
  );
  records.push(...husbandParents.records);
  if (husbandParents.famc) husbandChildren.push(husbandParents.famc);

  const wifeChildren: GedNode[] = [node(1, "NAME", `${col(row, "wifeName")} /${col(row, "wifeSurname")}/`)];
  pushEvent(wifeChildren, "BIRT", col(row, "wifeBirth"), "");
  wifeChildren.push(node(1, "FAMS", famId));
  const wifeParents = buildParentsRecords(
    `@${ID_PREFIX}${n}W`,
    wifeId,
    parseRelativeList(col(row, "wifeFather"))[0],
    parseRelativeList(col(row, "wifeMother"))[0],
  );
  records.push(...wifeParents.records);
  if (wifeParents.famc) wifeChildren.push(wifeParents.famc);

  const famChildren: GedNode[] = [node(1, "HUSB", husbandId), node(1, "WIFE", wifeId)];
  pushEvent(famChildren, "MARR", col(row, "marriageDate"), col(row, "marriagePlace"));
  for (const url of col(row, "links").split(",").map((s) => s.trim()).filter(Boolean)) {
    famChildren.push(node(1, "WWW", url));
  }
  parseRelativeList(col(row, "children")).forEach((child, i) => {
    const childId = `@${ID_PREFIX}${n}C${i + 1}@`;
    records.push(buildRelativeIndi(childId, child, famId, "FAMC"));
    famChildren.push(node(1, "CHIL", childId));
  });
  records.push(famNode(famId, famChildren));

  records.push({ level: 0, xref: husbandId, tag: "INDI", children: husbandChildren });
  records.push({ level: 0, xref: wifeId, tag: "INDI", children: wifeChildren });
  return records;
}
