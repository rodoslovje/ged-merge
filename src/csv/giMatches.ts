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

/** Column header set for the "family matches" CSV: pairs of rows describing a
 * couple (husband + wife) rather than a single person. */
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

/** Per-language column header translations for the family CSV format. */
const FAMILY_COLUMN_SETS: Record<string, FamilyColumnSet> = {
  en: {
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
  },
  sl: {
    husbandName: "Ime moža",
    husbandSurname: "Priimek moža",
    husbandBirth: "Rojstvo moža",
    wifeName: "Ime žene",
    wifeSurname: "Priimek žene",
    wifeBirth: "Rojstvo žene",
    marriageDate: "Datum poroke",
    marriagePlace: "Kraj poroke",
    links: "Povezave",
    children: "Otroci",
    husbandFather: "Oče moža",
    husbandMother: "Mati moža",
    wifeFather: "Oče žene",
    wifeMother: "Mati žene",
    genealogist: "Rodoslovec",
  },
  hr: {
    husbandName: "Ime muža",
    husbandSurname: "Prezime muža",
    husbandBirth: "Rođenje muža",
    wifeName: "Ime žene",
    wifeSurname: "Prezime žene",
    wifeBirth: "Rođenje žene",
    marriageDate: "Datum vjenčanja",
    marriagePlace: "Mjesto vjenčanja",
    links: "Poveznice",
    children: "Djeca",
    husbandFather: "Otac muža",
    husbandMother: "Majka muža",
    wifeFather: "Otac žene",
    wifeMother: "Majka žene",
    genealogist: "Rodoslovac",
  },
  de: {
    husbandName: "Vorname des Ehemanns",
    husbandSurname: "Nachname des Ehemanns",
    husbandBirth: "Geburt des Ehemanns",
    wifeName: "Vorname der Ehefrau",
    wifeSurname: "Nachname der Ehefrau",
    wifeBirth: "Geburt der Ehefrau",
    marriageDate: "Heiratsdatum",
    marriagePlace: "Heiratsort",
    links: "Links",
    children: "Kinder",
    husbandFather: "Vater des Ehemanns",
    husbandMother: "Mutter des Ehemanns",
    wifeFather: "Vater der Ehefrau",
    wifeMother: "Mutter der Ehefrau",
    genealogist: "Genealoge",
  },
  hu: {
    husbandName: "Férj utóneve",
    husbandSurname: "Férj vezetékneve",
    husbandBirth: "Férj születése",
    wifeName: "Feleség utóneve",
    wifeSurname: "Feleség vezetékneve",
    wifeBirth: "Feleség születése",
    marriageDate: "Házasságkötés dátuma",
    marriagePlace: "Házasságkötés helye",
    links: "Hivatkozások",
    children: "Gyermekek",
    husbandFather: "Férj apja",
    husbandMother: "Férj anyja",
    wifeFather: "Feleség apja",
    wifeMother: "Feleség anyja",
    genealogist: "Genealógus",
  },
  it: {
    husbandName: "Nome del marito",
    husbandSurname: "Cognome del marito",
    husbandBirth: "Nascita del marito",
    wifeName: "Nome della moglie",
    wifeSurname: "Cognome della moglie",
    wifeBirth: "Nascita della moglie",
    marriageDate: "Data del matrimonio",
    marriagePlace: "Luogo del matrimonio",
    links: "Collegamenti",
    children: "Figli",
    husbandFather: "Padre del marito",
    husbandMother: "Madre del marito",
    wifeFather: "Padre della moglie",
    wifeMother: "Madre della moglie",
    genealogist: "Genealogista",
  },
};

/** Match the header row against each known language's family column set. */
function detectFamilyColumns(header: string[]): Record<FamilyField, number> | undefined {
  for (const columns of Object.values(FAMILY_COLUMN_SETS)) {
    const index: Partial<Record<FamilyField, number>> = {};
    let ok = true;
    for (const [field, name] of Object.entries(columns) as [FamilyField, string][]) {
      const idx = header.indexOf(name);
      if (idx < 0) { ok = false; break; }
      index[field] = idx;
    }
    if (ok) return index as Record<FamilyField, number>;
  }
  return undefined;
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

/**
 * Parse family match rows, merging multiple rows for the same person into one
 * compare individual with multiple FAMS pointers (one per marriage). This way
 * a person who married more than once appears as a single match entry rather
 * than one per marriage.
 */
function parseFamilyMatches(dataRows: string[][], index: Record<FamilyField, number>): GiMatchesImport {
  const col = (row: string[], field: FamilyField): string => (row[index[field]] ?? "").trim();

  /** Normalised dedup key: used to recognise the same person across rows. */
  function keyStr(key: GiMasterKey): string {
    return `${key.given.toLowerCase()}|${key.surname.toLowerCase()}|${key.birthYear ?? ""}`;
  }

  // ── Pass 1: collect all valid family row-pairs ──────────────────────────
  interface FamilyEntry {
    famIdx: number;
    incomingRow: string[];
    husbandKey: GiMasterKey;
    wifeKey: GiMasterKey;
  }
  const entries: FamilyEntry[] = [];
  let famCounter = 0;

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
    famCounter++;
    entries.push({ famIdx: famCounter, incomingRow, husbandKey, wifeKey });
  }

  // ── Pass 2: assign one stable compare ID per unique master-side person ──
  let personCounter = 0;
  const personIdByKey = new Map<string, string>();
  const personMasterKeyByKey = new Map<string, GiMasterKey>();

  function getPersonId(key: GiMasterKey): string | undefined {
    if (!key.given && !key.surname) return undefined;
    const k = keyStr(key);
    if (!personIdByKey.has(k)) {
      personCounter++;
      personIdByKey.set(k, `@${ID_PREFIX}${personCounter}@`);
      personMasterKeyByKey.set(k, key);
    }
    return personIdByKey.get(k)!;
  }

  // Pre-assign in encounter order (husband before wife within each row).
  for (const { husbandKey, wifeKey } of entries) {
    getPersonId(husbandKey);
    getPersonId(wifeKey);
  }

  // ── Pass 3: accumulate per-person data across all rows ──────────────────
  interface PersonAcc {
    compareId: string;
    masterKey: GiMasterKey;
    given: string;
    surname: string;
    birth: string;
    famsIds: string[];
    father?: RelativeEntry;
    mother?: RelativeEntry;
  }
  const personAccs = new Map<string, PersonAcc>(); // compareId → acc

  function getAcc(
    key: GiMasterKey,
    given: string,
    surname: string,
    birth: string,
  ): PersonAcc | undefined {
    const compareId = getPersonId(key);
    if (!compareId) return undefined;
    if (!personAccs.has(compareId)) {
      personAccs.set(compareId, {
        compareId,
        masterKey: personMasterKeyByKey.get(keyStr(key))!,
        given: given || key.given,
        surname: surname || key.surname,
        birth,
        famsIds: [],
      });
    }
    return personAccs.get(compareId)!;
  }

  // Build FAM records while collecting FAMS pointers and parent data.
  const famRecords: GedNode[] = [];

  for (const { famIdx, incomingRow, husbandKey, wifeKey } of entries) {
    const famId = `@${ID_PREFIX}FAM${famIdx}@`;
    const husbandId = getPersonId(husbandKey);
    const wifeId = getPersonId(wifeKey);

    const famChildren: GedNode[] = [];
    if (husbandId) famChildren.push(node(1, "HUSB", husbandId));
    if (wifeId) famChildren.push(node(1, "WIFE", wifeId));
    pushEvent(famChildren, "MARR", col(incomingRow, "marriageDate"), col(incomingRow, "marriagePlace"));
    for (const url of col(incomingRow, "links").split(",").map((s) => s.trim()).filter(Boolean)) {
      famChildren.push(node(1, "WWW", url));
    }
    parseRelativeList(col(incomingRow, "children")).forEach((child, i) => {
      const childId = `@${ID_PREFIX}FAM${famIdx}C${i + 1}@`;
      famRecords.push(buildRelativeIndi(childId, child, famId, "FAMC"));
      famChildren.push(node(1, "CHIL", childId));
    });
    famRecords.push(famNode(famId, famChildren));

    // Husband accumulator
    const hacc = getAcc(husbandKey, col(incomingRow, "husbandName"), col(incomingRow, "husbandSurname"), col(incomingRow, "husbandBirth"));
    if (hacc) {
      hacc.famsIds.push(famId);
      if (!hacc.father && !hacc.mother) {
        hacc.father = parseRelativeList(col(incomingRow, "husbandFather"))[0];
        hacc.mother = parseRelativeList(col(incomingRow, "husbandMother"))[0];
      }
    }

    // Wife accumulator
    const wacc = getAcc(wifeKey, col(incomingRow, "wifeName"), col(incomingRow, "wifeSurname"), col(incomingRow, "wifeBirth"));
    if (wacc) {
      wacc.famsIds.push(famId);
      if (!wacc.father && !wacc.mother) {
        wacc.father = parseRelativeList(col(incomingRow, "wifeFather"))[0];
        wacc.mother = parseRelativeList(col(incomingRow, "wifeMother"))[0];
      }
    }
  }

  // ── Pass 4: emit one INDI per unique person ──────────────────────────────
  // IDs: person p → @SGI{p}@; their parents prefix → @SGI{p} → @SGI{p}FAM@/@SGI{p}F@/@SGI{p}M@
  const records: GedNode[] = [...famRecords];
  const pairs: GiPair[] = [];

  for (const acc of personAccs.values()) {
    const { compareId, masterKey, given, surname, birth, famsIds, father, mother } = acc;

    const indiChildren: GedNode[] = [node(1, "NAME", `${given} /${surname}/`)];
    if (birth && !isAnnotation(birth)) {
      indiChildren.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", birth)] });
    }
    for (const famId of famsIds) indiChildren.push(node(1, "FAMS", famId));

    // Parents prefix derived from compareId ("@SGI{p}@" → "@SGI{p}")
    const parPrefix = compareId.slice(0, -1);
    const par = buildParentsRecords(parPrefix, compareId, father, mother);
    records.push(...par.records);
    if (par.famc) indiChildren.push(par.famc);

    records.push({ level: 0, xref: compareId, tag: "INDI", children: indiChildren });
    pairs.push({ masterKey, compareId });
  }

  return finish(records, pairs);
}
