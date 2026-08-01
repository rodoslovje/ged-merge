import { buildDataset } from "../gedcom/builder";
import { parseDate } from "../gedcom/date";
import type { Dataset, GedNode, ParseResult } from "../gedcom/types";
import { foldToken } from "../match/text";

/**
 * Import for the "matches" CSV exported by a genealogical index site such as
 * indeks.rodoslovje.si (the Slovenian Genealogical Index): a list of person
 * pairs, two rows per match — the first row is the person as recorded by the
 * main tree's own contributor, the second is the corresponding record from
 * another source (e.g. a cemetery index). We resolve the first row against
 * the main dataset by exact name + birth year, and present the second row
 * as a synthetic "incoming" individual for review/merge.
 *
 * The site's column headers are translated per UI language; `COLUMN_SETS`
 * lists the translations we know about so a CSV exported in any of those
 * languages is recognised. Date values themselves are always GEDCOM-style
 * (English month abbreviations) regardless of UI language.
 */

/**
 * Per-language column header translations for the simple 1:1 fields.
 *
 * The strings are the site's own `col_*` i18n values. Purely informational
 * columns are deliberately *not* listed: the export used to end with a
 * "Rodoslovec"/"Genealogist" column that was later relabelled to
 * "Vir"/"Source", and since we never read it, requiring it only broke
 * imports of newer files. Only columns we actually use take part in
 * header detection.
 */
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
  /** Separate parent columns (newer export format), replacing `parents`. */
  father: string;
  mother: string;
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
    father: "Oče",
    mother: "Mati",
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
    father: "Father",
    mother: "Mother",
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
    father: "Vater",
    mother: "Mutter",
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
    father: "Otac",
    mother: "Majka",
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
    father: "Apa",
    mother: "Anya",
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
    father: "Padre",
    mother: "Madre",
    confidence: "Confidenza",
  },
};

/** Prefix for the synthetic individual IDs produced from this import. */
const ID_PREFIX = "SGI";

/** The main-side identity used to find the corresponding individual. */
export interface GiMainKey {
  given: string;
  surname: string;
  birthYear?: number;
}

/** One CSV match pair: the main-side key plus the synthetic compare individual it produced. */
export interface GiPair {
  mainKey: GiMainKey;
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

/**
 * Strip a trailing "(...)" annotation some exports append to a surname — an
 * archival spelling variant (e.g. the German transliteration "Jakopič
 * (Jakopetsch)" in old church-register extracts) or a maiden/married-name
 * cross-reference (e.g. "Cegnar (Briško)") — so it doesn't pollute the
 * literal surname used both to look up the main individual and to score
 * how well the two records match. Returns the value unchanged when there's
 * no trailing parenthetical.
 */
function stripSurnameAnnotation(value: string): string {
  return value.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** Column fields every export includes, regardless of which "parents" shape it uses. */
type RequiredField = Exclude<keyof ColumnSet, "parents" | "father" | "mother">;

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
      if (field === "parents" || field === "father" || field === "mother") continue;
      const idx = header.indexOf(name);
      if (idx < 0) {
        ok = false;
        break;
      }
      index[field as RequiredField] = idx;
    }
    if (!ok) continue;

    const parentsIndex = header.indexOf(columns.parents);
    const fatherIndex = header.indexOf(columns.father);
    const motherIndex = header.indexOf(columns.mother);
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
 * couple (husband + wife) rather than a single person. As with `ColumnSet`,
 * the trailing informational contributor/source column is left out — we never
 * read it and its label has changed over time. */
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
  },
  de: {
    husbandName: "Vorname des Mannes",
    husbandSurname: "Nachname des Mannes",
    husbandBirth: "Geburt des Mannes",
    wifeName: "Vorname der Frau",
    wifeSurname: "Nachname der Frau",
    wifeBirth: "Geburt der Frau",
    marriageDate: "Heiratsdatum",
    marriagePlace: "Heiratsort",
    links: "Links",
    children: "Kinder",
    husbandFather: "Vater des Mannes",
    husbandMother: "Mutter des Mannes",
    wifeFather: "Vater der Frau",
    wifeMother: "Mutter der Frau",
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
  },
  it: {
    husbandName: "Nome del marito",
    husbandSurname: "Cognome del marito",
    husbandBirth: "Nascita del marito",
    wifeName: "Nome della moglie",
    wifeSurname: "Cognome della moglie",
    wifeBirth: "Nascita della moglie",
    marriageDate: "Data di matrimonio",
    marriagePlace: "Luogo di matrimonio",
    links: "Collegamenti",
    children: "Figli",
    husbandFather: "Padre del marito",
    husbandMother: "Madre del marito",
    wifeFather: "Padre della moglie",
    wifeMother: "Madre della moglie",
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
 * plus the main-side keys needed to resolve each pair to a main
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
  const dataset = buildDataset(parsed);
  // The GI matches CSV doesn't reliably carry birth dates (family rows often
  // have only a marriage date), so let matching use the marriage-plausibility
  // fallback for birth-less records instead of the missing-key penalty.
  dataset.sparseBirthDates = true;
  return { dataset, pairs };
}

function parsePersonMatches(dataRows: string[][], layout: ColumnLayout): GiMatchesImport {
  const col = (row: string[], field: RequiredField): string => (row[layout.index[field]] ?? "").trim();
  const colAt = (row: string[], idx: number | undefined): string =>
    idx === undefined ? "" : (row[idx] ?? "").trim();

  interface Row {
    mainKey: GiMainKey;
    incomingRow: string[];
    compareId: string;
  }
  const rows: Row[] = [];
  const people = newPeople();

  // Pass 1: one compare id per CSV row-pair, registered under the incoming
  // person's own name + birth year *before* any relative is built — so a row
  // that names this person as someone else's partner or parent lands on this
  // record instead of minting a stand-in for them.
  let n = 0;
  for (let i = 0; i + 1 < dataRows.length; i += 2) {
    const mainRow = dataRows[i];
    const incomingRow = dataRows[i + 1];
    const mainKey: GiMainKey = {
      given: col(mainRow, "given"),
      surname: stripSurnameAnnotation(col(mainRow, "surname")),
      birthYear: parseDate(col(mainRow, "birthDate")).year,
    };
    if (!mainKey.given || !mainKey.surname) continue;

    n++;
    const compareId = `@${ID_PREFIX}${n}@`;
    rows.push({ mainKey, incomingRow, compareId });
    claimKey(
      people,
      compareId,
      dedupKey(
        col(incomingRow, "given"),
        stripSurnameAnnotation(col(incomingRow, "surname")),
        parseDate(col(incomingRow, "birthDate")).year,
      ),
    );
  }

  // Pass 2: the row people themselves, so every record a relative can resolve to
  // exists before the families are wired up.
  for (const { incomingRow, compareId } of rows) {
    addPerson(people, compareId, personIndiChildren(incomingRow, col));
  }

  // Pass 3: parents and partners, resolved through the registry.
  for (const { incomingRow, compareId } of rows) {
    buildPairRelatives(people, compareId, incomingRow, col, colAt, layout);
  }

  // The CSV's own rows first: they carry the index's main-side key, and a
  // relative that resolves to the same main individual is dropped as a duplicate.
  const pairs: GiPair[] = rows.map(({ mainKey, compareId }) => ({ mainKey, compareId }));
  for (const [compareId, mainKey] of people.relativeKeys) pairs.push({ mainKey, compareId });

  return finish(people.records, pairs);
}

/**
 * Accumulates the synthetic compare records as the CSV is read, so a person the
 * file names in several places — a match row of their own, a partner in one row,
 * a parent in another — becomes *one* INDI carrying all their families, instead
 * of a disconnected stand-in per mention.
 */
interface People {
  records: GedNode[];
  /** INDI node by compare id, so pointers can be appended after creation. */
  indi: Map<string, GedNode>;
  /** Dedup key → compare id. Only people with a known birth year take part:
   *  without one, two same-named relatives are as likely to be two people. */
  idByKey: Map<string, string>;
  /** Couple key → FAM record, so one marriage isn't recorded as two families. */
  famByCouple: Map<string, GedNode>;
  /** Relatives that can be offered as matches in their own right: compare id →
   *  the name + birth year to look up in the main file. The CSV's own rows are
   *  absent — they carry the index's main-side key instead. */
  relativeKeys: Map<string, GiMainKey>;
}

function newPeople(): People {
  return {
    records: [],
    indi: new Map(),
    idByKey: new Map(),
    famByCouple: new Map(),
    relativeKeys: new Map(),
  };
}

/** Folded "given|surname|year" identity of a person, or undefined when the CSV
 *  doesn't say enough about them to risk merging two mentions into one. */
function dedupKey(given: string, surname: string, birthYear: number | undefined): string | undefined {
  if (!given || !surname || birthYear === undefined) return undefined;
  return `${foldToken(given)}|${foldToken(surname)}|${birthYear}`;
}

/** Reserve a dedup key for a compare id (first mention wins). */
function claimKey(people: People, id: string, key: string | undefined): void {
  if (key && !people.idByKey.has(key)) people.idByKey.set(key, id);
}

function addPerson(people: People, id: string, children: GedNode[]): GedNode {
  const record: GedNode = { level: 0, xref: id, tag: "INDI", children };
  people.records.push(record);
  people.indi.set(id, record);
  return record;
}

function addPointer(people: People, id: string, tag: "FAMS" | "FAMC", famId: string): void {
  const record = people.indi.get(id);
  if (!record) return;
  if (record.children.some((c) => c.tag === tag && c.value === famId)) return;
  record.children.push(node(1, tag, famId));
}

/**
 * Resolve one parsed relative to a compare individual: the record the CSV
 * already has for them when they're named elsewhere too, otherwise a fresh
 * synthetic INDI under `fallbackId`. A fresh record with a full name + birth
 * year is also offered as a match of its own, so a partner or parent the main
 * file already holds can be reviewed rather than only grafted.
 */
function resolveRelative(people: People, entry: RelativeEntry, fallbackId: string): string {
  const { given, surname } = splitName(entry.name);
  const birthYear = entry.date && !isAnnotation(entry.date) ? parseDate(entry.date).year : undefined;
  const key = dedupKey(given, surname, birthYear);
  const known = key ? people.idByKey.get(key) : undefined;
  if (known) return known;

  const children: GedNode[] = [node(1, "NAME", `${given} /${surname}/`)];
  if (entry.date && !isAnnotation(entry.date)) {
    children.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", entry.date)] });
  }
  addPerson(people, fallbackId, children);
  claimKey(people, fallbackId, key);
  if (key) people.relativeKeys.set(fallbackId, { given, surname, birthYear });
  return fallbackId;
}

/**
 * The FAM for a couple: the one already recorded when both spouses are known and
 * the CSV has married them elsewhere (as partners in one row, as a child's
 * parents in another), otherwise a fresh record under `fallbackId` with the
 * spouses' FAMS pointers attached. Spouse slots are only assigned on the fresh
 * record — an existing family keeps the roles it was created with.
 */
function coupleFam(
  people: People,
  husbId: string | undefined,
  wifeId: string | undefined,
  fallbackId: string,
): { id: string; node: GedNode; fresh: boolean } {
  // Order-independent, since the CSV doesn't always say which spouse is which:
  // the same couple must not become two families with the roles swapped.
  const coupleKey = husbId && wifeId ? [husbId, wifeId].sort().join("|") : undefined;
  const known = coupleKey ? people.famByCouple.get(coupleKey) : undefined;
  if (known) return { id: known.xref!, node: known, fresh: false };

  const children: GedNode[] = [];
  if (husbId) children.push(node(1, "HUSB", husbId));
  if (wifeId) children.push(node(1, "WIFE", wifeId));
  const record = famNode(fallbackId, children);
  people.records.push(record);
  if (coupleKey) people.famByCouple.set(coupleKey, record);
  for (const id of [husbId, wifeId]) if (id) addPointer(people, id, "FAMS", fallbackId);
  return { id: fallbackId, node: record, fresh: true };
}

/** Add a child to a family, once. */
function addChild(fam: GedNode, childId: string): void {
  if (fam.children.some((c) => c.tag === "CHIL" && c.value === childId)) return;
  fam.children.push(node(1, "CHIL", childId));
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
  const stripped = stripSurnameAnnotation(full);
  const idx = stripped.lastIndexOf(" ");
  if (idx < 0) return { given: stripped, surname: "" };
  return { given: stripped.slice(0, idx).trim(), surname: stripped.slice(idx + 1).trim() };
}

function famNode(xref: string, children: GedNode[]): GedNode {
  return { level: 0, xref, tag: "FAM", children };
}

/** The INDI children (name, events, links) of one CSV row's incoming person. */
function personIndiChildren(
  row: string[],
  col: (row: string[], field: RequiredField) => string,
): GedNode[] {
  const children: GedNode[] = [];
  const given = col(row, "given");
  const surname = stripSurnameAnnotation(col(row, "surname"));
  children.push(node(1, "NAME", `${given} /${surname}/`));

  pushEvent(children, "BIRT", col(row, "birthDate"), col(row, "birthPlace"));
  pushEvent(children, "DEAT", col(row, "deathDate"), col(row, "deathPlace"));
  pushEvent(children, "BURI", col(row, "burialDate"), col(row, "burialPlace"));

  for (const url of col(row, "links").split(",").map((s) => s.trim()).filter(Boolean)) {
    children.push(node(1, "WWW", url));
  }
  return children;
}

/**
 * Wire one CSV row's parents and partners into the shared registry: each becomes
 * a real family relationship, on the record the CSV already has for that person
 * where there is one.
 */
function buildPairRelatives(
  people: People,
  compareId: string,
  row: string[],
  col: (row: string[], field: RequiredField) => string,
  colAt: (row: string[], idx: number | undefined) => string,
  layout: ColumnLayout,
): void {
  // "@SGI3@" → "@SGI3", the prefix this row's own stand-in records are named after.
  const prefix = compareId.slice(0, -1);

  // Parents: separate Father/Mother columns (newer format) take priority over
  // the combined "Parents"/"Starši" column (older format: father then mother).
  let father = parseRelativeList(colAt(row, layout.fatherIndex))[0];
  let mother = parseRelativeList(colAt(row, layout.motherIndex))[0];
  if (!father && !mother) {
    const parents = parseRelativeList(colAt(row, layout.parentsIndex));
    father = parents[0];
    mother = parents[1];
  }
  if (father || mother) {
    const fatherId = father ? resolveRelative(people, father, `${prefix}F@`) : undefined;
    const motherId = mother ? resolveRelative(people, mother, `${prefix}M@`) : undefined;
    const fam = coupleFam(people, fatherId, motherId, `${prefix}FAM@`);
    addChild(fam.node, compareId);
    addPointer(people, compareId, "FAMC", fam.id);
  }

  // Partners: each entry is a family shared with this row's person.
  parseRelativeList(col(row, "partners")).forEach((partner, i) => {
    const partnerId = resolveRelative(people, partner, `${prefix}P${i + 1}@`);
    const mainIsWife = partner.role === "husband";
    const husbId = mainIsWife ? partnerId : compareId;
    const wifeId = mainIsWife ? compareId : partnerId;
    coupleFam(people, husbId, wifeId, `${prefix}PFAM${i + 1}@`);
  });
}

/** Push a dated/placed/linked event node, omitting it entirely when date, place
 *  and links are all empty/annotations. Links (e.g. a Matricula marriage-book
 *  URL) are attached as the event's own WWW children so review/merge treats
 *  them as that event's citation rather than a disconnected record-level link. */
function pushEvent(into: GedNode[], tag: string, date: string, place: string, links: string[] = []): void {
  const children: GedNode[] = [];
  if (date && !isAnnotation(date)) children.push(node(2, "DATE", date));
  if (place && !isAnnotation(place)) children.push(node(2, "PLAC", place));
  for (const url of links) children.push(node(2, "WWW", url));
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
  function keyStr(key: GiMainKey): string {
    return `${key.given.toLowerCase()}|${key.surname.toLowerCase()}|${key.birthYear ?? ""}`;
  }

  // ── Pass 1: collect all valid family row-pairs ──────────────────────────
  interface FamilyEntry {
    famIdx: number;
    incomingRow: string[];
    husbandKey: GiMainKey;
    wifeKey: GiMainKey;
  }
  const entries: FamilyEntry[] = [];
  let famCounter = 0;

  for (let i = 0; i + 1 < dataRows.length; i += 2) {
    const mainRow = dataRows[i];
    const incomingRow = dataRows[i + 1];
    const husbandKey: GiMainKey = {
      given: col(mainRow, "husbandName"),
      surname: stripSurnameAnnotation(col(mainRow, "husbandSurname")),
      birthYear: parseDate(col(mainRow, "husbandBirth")).year,
    };
    const wifeKey: GiMainKey = {
      given: col(mainRow, "wifeName"),
      surname: stripSurnameAnnotation(col(mainRow, "wifeSurname")),
      birthYear: parseDate(col(mainRow, "wifeBirth")).year,
    };
    if (!husbandKey.given && !husbandKey.surname && !wifeKey.given && !wifeKey.surname) continue;
    famCounter++;
    entries.push({ famIdx: famCounter, incomingRow, husbandKey, wifeKey });
  }

  // ── Pass 2: assign one stable compare ID per unique main-side person ──
  let personCounter = 0;
  const personIdByKey = new Map<string, string>();
  const personMainKeyByKey = new Map<string, GiMainKey>();

  function getPersonId(key: GiMainKey): string | undefined {
    if (!key.given && !key.surname) return undefined;
    const k = keyStr(key);
    if (!personIdByKey.has(k)) {
      personCounter++;
      personIdByKey.set(k, `@${ID_PREFIX}${personCounter}@`);
      personMainKeyByKey.set(k, key);
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
    mainKey: GiMainKey;
    given: string;
    surname: string;
    birth: string;
    father?: RelativeEntry;
    mother?: RelativeEntry;
  }
  const personAccs = new Map<string, PersonAcc>(); // compareId → acc

  function getAcc(
    key: GiMainKey,
    given: string,
    surname: string,
    birth: string,
  ): PersonAcc | undefined {
    const compareId = getPersonId(key);
    if (!compareId) return undefined;
    if (!personAccs.has(compareId)) {
      personAccs.set(compareId, {
        compareId,
        mainKey: personMainKeyByKey.get(keyStr(key))!,
        given: given || key.given,
        surname: surname || key.surname,
        birth,
      });
    }
    return personAccs.get(compareId)!;
  }

  for (const { incomingRow, husbandKey, wifeKey } of entries) {
    const hacc = getAcc(husbandKey, col(incomingRow, "husbandName"), stripSurnameAnnotation(col(incomingRow, "husbandSurname")), col(incomingRow, "husbandBirth"));
    if (hacc && !hacc.father && !hacc.mother) {
      hacc.father = parseRelativeList(col(incomingRow, "husbandFather"))[0];
      hacc.mother = parseRelativeList(col(incomingRow, "husbandMother"))[0];
    }
    const wacc = getAcc(wifeKey, col(incomingRow, "wifeName"), stripSurnameAnnotation(col(incomingRow, "wifeSurname")), col(incomingRow, "wifeBirth"));
    if (wacc && !wacc.father && !wacc.mother) {
      wacc.father = parseRelativeList(col(incomingRow, "wifeFather"))[0];
      wacc.mother = parseRelativeList(col(incomingRow, "wifeMother"))[0];
    }
  }

  // ── Pass 4: emit one INDI per unique person ──────────────────────────────
  // IDs: person p → @SGI{p}@; their parents prefix → @SGI{p} → @SGI{p}FAM@/@SGI{p}F@/@SGI{p}M@
  const people = newPeople();
  const pairs: GiPair[] = [];

  for (const acc of personAccs.values()) {
    const { compareId, mainKey, given, surname, birth } = acc;
    const indiChildren: GedNode[] = [node(1, "NAME", `${given} /${surname}/`)];
    const dated = birth && !isAnnotation(birth);
    if (dated) indiChildren.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", birth)] });
    addPerson(people, compareId, indiChildren);
    // Registered under the *incoming* spelling and birth year, which is what a
    // relative named in another row is written with — so a spouse who is also
    // someone's child or parent elsewhere lands on this record.
    claimKey(people, compareId, dedupKey(given, surname, dated ? parseDate(birth).year : undefined));
    pairs.push({ mainKey, compareId });
  }

  // ── Pass 5: marriages and the relatives named around them ────────────────
  for (const { famIdx, incomingRow, husbandKey, wifeKey } of entries) {
    const fam = coupleFam(people, getPersonId(husbandKey), getPersonId(wifeKey), `@${ID_PREFIX}FAM${famIdx}@`);
    if (fam.fresh) {
      const marriageLinks = col(incomingRow, "links").split(",").map((s) => s.trim()).filter(Boolean);
      pushEvent(fam.node.children, "MARR", col(incomingRow, "marriageDate"), col(incomingRow, "marriagePlace"), marriageLinks);
    }
    parseRelativeList(col(incomingRow, "children")).forEach((child, i) => {
      const childId = resolveRelative(people, child, `@${ID_PREFIX}FAM${famIdx}C${i + 1}@`);
      addChild(fam.node, childId);
      addPointer(people, childId, "FAMC", fam.id);
    });
  }

  for (const { compareId, father, mother } of personAccs.values()) {
    if (!father && !mother) continue;
    const prefix = compareId.slice(0, -1);
    const fatherId = father ? resolveRelative(people, father, `${prefix}F@`) : undefined;
    const motherId = mother ? resolveRelative(people, mother, `${prefix}M@`) : undefined;
    const fam = coupleFam(people, fatherId, motherId, `${prefix}FAM@`);
    addChild(fam.node, compareId);
    addPointer(people, compareId, "FAMC", fam.id);
  }

  for (const [compareId, mainKey] of people.relativeKeys) pairs.push({ mainKey, compareId });
  return finish(people.records, pairs);
}
