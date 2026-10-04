import { buildDataset } from "../gedcom/builder";
import { parseDate } from "../gedcom/date";
import type { Dataset, GedNode, ParseResult, Sex } from "../gedcom/types";
import { foldToken } from "../match/text";
import { classifyBookType, recognizeSourceUrl, siteEventTag } from "../tools/sourceReshape";
import { parseCsvText } from "./csvText";
import {
  addChild,
  addEventLink,
  addPerson,
  addPointer,
  addRecordLink,
  addSex,
  coupleFam,
  inferSexFromNames,
  newPeople as newBasePeople,
  node,
  type People as BasePeople,
  pushEvent,
  settleGuessedRoles,
  splitName,
  stripSurnameAnnotation,
  withoutAnnotation,
} from "./people";

export { parseCsvText } from "./csvText";

/**
 * Import for the CSV tables exported by a genealogical index site such as
 * indeks.rodoslovje.si (the Slovenian Genealogical Index). Two exports share
 * one set of columns and differ in what a row is:
 *
 *  - The **matches** export is a list of person pairs, two rows per match —
 *    the first row is the person as recorded by the main tree's own
 *    contributor, the second the corresponding record from another source
 *    (e.g. a cemetery index). We resolve the first row against the main
 *    dataset by exact name + birth year, and present the second row as a
 *    synthetic "incoming" individual for review/merge.
 *  - The **search** export is the result list of a search on the index — one
 *    row per person (or per family), with nothing said about the reader's own
 *    tree. Every row becomes an incoming record and the ordinary matching
 *    engine finds its counterpart, as it does for a GEDCOM compare file.
 *
 * The one column that tells the two apart is the confidence of a match
 * ("Zaupanje"/"Confidence"), which only the matches export carries.
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
  /** The match's confidence — present in the matches export only, so its
   *  header is what tells a matches export from a search export. */
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

/**
 * The one folded "given|surname|year" spelling of a person key — shared by
 * every consumer (row dedup here, the main-side index in match/giMatch).
 * Diacritic-blind via foldToken on purpose: three builders used to exist and
 * the family-rows one folded case only, so a spouse written "Rožič" in one
 * row and "Rozic" in another minted two compare people, each wired into a
 * different marriage.
 */
export function giPersonKey(key: GiMainKey): string {
  return `${foldToken(key.given)}|${foldToken(key.surname)}|${key.birthYear ?? ""}`;
}

/** One CSV match pair: the main-side key plus the synthetic compare individual it produced. */
export interface GiPair {
  mainKey: GiMainKey;
  compareId: string;
}

export interface GiMatchesImport {
  dataset: Dataset;
  /** The main-side keys of a matches export; absent for a search export, whose
   *  rows name nobody in the main file and go through the matching engine. */
  pairs?: GiPair[];
}

/** Column fields every export includes, regardless of which "parents" shape it
 *  uses — and whichever of the two exports it is. */
type RequiredField = Exclude<keyof ColumnSet, "parents" | "father" | "mother" | "confidence">;

/** Resolved column layout for one CSV: which header row index has which field. */
interface ColumnLayout {
  index: Record<RequiredField, number>;
  /** Combined "Starši"/"Parents"/etc. column (older export format), when present. */
  parentsIndex?: number;
  fatherIndex?: number;
  motherIndex?: number;
  /** Rows come in main/incoming pairs (a matches export) rather than one
   *  record per row (a search export). */
  paired: boolean;
}

/** The confidence column's header in every language: the matches export's
 *  signature, in the person and the family shape alike. */
const CONFIDENCE_HEADERS = new Set(Object.values(COLUMN_SETS).map((c) => c.confidence));

/** Whether a header is a matches export's — see {@link CONFIDENCE_HEADERS}. */
function isPairedHeader(header: string[]): boolean {
  return header.some((h) => CONFIDENCE_HEADERS.has(h));
}

/** Match the header row against each known language's column set. */
function detectColumns(header: string[]): ColumnLayout | undefined {
  for (const columns of Object.values(COLUMN_SETS)) {
    const index: Partial<Record<RequiredField, number>> = {};
    let ok = true;
    for (const [field, name] of Object.entries(columns) as [keyof ColumnSet, string][]) {
      if (field === "parents" || field === "father" || field === "mother" || field === "confidence") continue;
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
      paired: isPairedHeader(header),
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
 * Parse a genealogical index CSV into a synthetic compare `Dataset` — plus,
 * for a matches export, the main-side keys needed to resolve each pair to a
 * main individual. Two CSV shapes are recognised: per-person (one individual
 * per pair, or per row) and per-family (one couple per pair or row, yielding
 * up to two pairs — husband and wife).
 *
 * Throws if the header doesn't match either known shape.
 */
export function parseGiMatchesCsv(text: string): GiMatchesImport {
  const rows = parseCsvText(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) throw new Error("Empty CSV file");

  const header = rows[0];
  // Trailing metadata rows (source/date/search footer) have a different
  // column count than the header and are ignored — dropped from the end, not
  // filtered out wherever they occur: rows come in main/incoming pairs, and a
  // data row written short (a trailing empty field dropped) that was filtered
  // away swapped the roles of every pair after it. Such a row is padded.
  const body = rows.slice(1);
  let end = body.length;
  while (end > 0 && body[end - 1].length !== header.length) end--;
  const dataRows = body.slice(0, end).map((r) =>
    r.length >= header.length ? r.slice(0, header.length) : [...r, ...Array<string>(header.length - r.length).fill("")],
  );

  const layout = detectColumns(header);
  if (layout) return parsePersonMatches(dataRows, layout);

  const familyIndex = detectFamilyColumns(header);
  if (familyIndex) return parseFamilyMatches(dataRows, familyIndex, isPairedHeader(header));

  throw new Error("Unrecognized index CSV: unknown column headers");
}

function finish(records: GedNode[], pairs: GiPair[] | undefined): GiMatchesImport {
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
    /** Who the row concerns in the main file — a matches export only. */
    mainKey?: GiMainKey;
    incomingRow: string[];
    compareId: string;
  }
  const rows: Row[] = [];
  const people = newPeople();

  // Pass 1: one compare id per CSV row-pair (or per row, in a search export),
  // registered under the incoming person's own name + birth year *before* any
  // relative is built — so a row that names this person as someone else's
  // partner or parent lands on this record instead of minting a stand-in for
  // them.
  const step = layout.paired ? 2 : 1;
  let n = 0;
  for (let i = 0; i + step - 1 < dataRows.length; i += step) {
    const incomingRow = dataRows[i + step - 1];
    let mainKey: GiMainKey | undefined;
    if (layout.paired) {
      const mainRow = dataRows[i];
      mainKey = {
        given: col(mainRow, "given"),
        surname: stripSurnameAnnotation(col(mainRow, "surname")),
        birthYear: parseDate(withoutAnnotation(col(mainRow, "birthDate"))).year,
      };
      if (!mainKey.given || !mainKey.surname) continue;
    } else if (!col(incomingRow, "given") && !col(incomingRow, "surname")) {
      continue; // a row with no name at all says nothing worth matching
    }

    n++;
    const compareId = `@${ID_PREFIX}${n}@`;
    rows.push({ mainKey, incomingRow, compareId });
    claimKey(
      people,
      compareId,
      dedupKey(
        col(incomingRow, "given"),
        stripSurnameAnnotation(col(incomingRow, "surname")),
        parseDate(withoutAnnotation(col(incomingRow, "birthDate"))).year,
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

  inferSexFromNames(people);
  settleGuessedRoles(people);
  if (!layout.paired) return finish(people.records, undefined);

  // The CSV's own rows first: they carry the index's main-side key, and a
  // relative that resolves to the same main individual is dropped as a duplicate.
  const pairs: GiPair[] = rows.map(({ mainKey, compareId }) => ({ mainKey: mainKey!, compareId }));
  for (const [compareId, mainKey] of people.relativeKeys) pairs.push({ mainKey, compareId });

  return finish(people.records, pairs);
}

/**
 * The shared record registry (see `people.ts`) plus what only the matches CSV
 * needs: how a person is recognised across rows, and which of them may be
 * offered as a match in their own right.
 */
interface People extends BasePeople {
  /** Dedup key → compare id. Only people with a known birth year take part:
   *  without one, two same-named relatives are as likely to be two people. */
  idByKey: Map<string, string>;
  /** Relatives that can be offered as matches in their own right: compare id →
   *  the name + birth year to look up in the main file. The CSV's own rows are
   *  absent — they carry the index's main-side key instead. */
  relativeKeys: Map<string, GiMainKey>;
}

function newPeople(): People {
  return { ...newBasePeople(), idByKey: new Map(), relativeKeys: new Map() };
}

/** Folded "given|surname|year" identity of a person, or undefined when the CSV
 *  doesn't say enough about them to risk merging two mentions into one. */
function dedupKey(given: string, surname: string, birthYear: number | undefined): string | undefined {
  if (!given || !surname || birthYear === undefined) return undefined;
  return giPersonKey({ given, surname, birthYear });
}

/** Reserve a dedup key for a compare id (first mention wins). */
function claimKey(people: People, id: string, key: string | undefined): void {
  if (key && !people.idByKey.has(key)) people.idByKey.set(key, id);
}

/**
 * Resolve one parsed relative to a compare individual: the record the CSV
 * already has for them when they're named elsewhere too, otherwise a fresh
 * synthetic INDI under `fallbackId`. A fresh record with a full name + birth
 * year is also offered as a match of its own, so a partner or parent the main
 * file already holds can be reviewed rather than only grafted.
 */
function resolveRelative(people: People, entry: RelativeEntry, fallbackId: string, sex?: Sex): string {
  const { given, surname } = splitName(entry.name);
  const birthYear = entry.date ? parseDate(withoutAnnotation(entry.date)).year : undefined;
  const key = dedupKey(given, surname, birthYear);
  const known = key ? people.idByKey.get(key) : undefined;
  if (known) {
    addSex(people, known, sex);
    return known;
  }

  const children: GedNode[] = [node(1, "NAME", `${given} /${surname}/`)];
  if (sex) children.push(node(1, "SEX", sex));
  const entryDate = withoutAnnotation(entry.date ?? "");
  if (entryDate) {
    children.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", entryDate)] });
  }
  addPerson(people, fallbackId, children);
  claimKey(people, fallbackId, key);
  if (key) people.relativeKeys.set(fallbackId, { given, surname, birthYear });
  return fallbackId;
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

/** The INDI children (name, events, links) of one CSV row's incoming person. */
function personIndiChildren(
  row: string[],
  col: (row: string[], field: RequiredField) => string,
): GedNode[] {
  const children: GedNode[] = [];
  const given = col(row, "given");
  const surname = stripSurnameAnnotation(col(row, "surname"));
  children.push(node(1, "NAME", `${given} /${surname}/`));

  const events: Array<{ tag: string; date: string; place: string }> = [
    { tag: "BIRT", date: col(row, "birthDate"), place: col(row, "birthPlace") },
    { tag: "DEAT", date: col(row, "deathDate"), place: col(row, "deathPlace") },
    { tag: "BURI", date: col(row, "burialDate"), place: col(row, "burialPlace") },
  ];
  const { byTag, recordLinks } = splitRowLinks(col(row, "links"), events);
  for (const e of events) pushEvent(children, e.tag, e.date, e.place, byTag.get(e.tag));
  for (const url of recordLinks) children.push(node(1, "WWW", url));
  return children;
}

/**
 * Which event each of a row's links documents. A cemetery link is evidence of
 * the burial the same row names, an obituary of the death — attached there, the
 * link is reviewed and merged as that event's source rather than as a bare link
 * on the person, which is where the reader has to look for it anyway.
 *
 * Only an event the row itself gives a date or place to may take one: a link
 * alone is too thin a reason to assert an event the index never stated.
 */
function splitRowLinks(
  linksCell: string,
  events: Array<{ tag: string; date: string; place: string }>,
): { byTag: Map<string, string[]>; recordLinks: string[] } {
  const byTag = new Map<string, string[]>();
  const recordLinks: string[] = [];
  const stated = new Set(
    events.filter((e) => withoutAnnotation(e.date) || withoutAnnotation(e.place)).map((e) => e.tag),
  );
  for (const url of linksCell.split(",").map((s) => s.trim()).filter(Boolean)) {
    const site = recognizeSourceUrl(url)?.site;
    const tag = site && siteEventTag(site);
    if (tag && stated.has(tag)) byTag.set(tag, [...(byTag.get(tag) ?? []), url]);
    else recordLinks.push(url);
  }
  return { byTag, recordLinks };
}

/**
 * Where a family row's links belong. The row is about a couple, but its links
 * are rarely about the wedding: the index's family rows come from graves as
 * often as from marriage books, and a grave photograph is evidence of the
 * burial of each spouse on it — never of the marriage, which the row may not
 * even date. So a link goes by what its site documents: a cemetery (or
 * obituary) page onto that event of each spouse, a page recognised as a
 * marriage book onto the marriage, and a page that says nothing about itself
 * onto both spouses as their own link, where the reader can still find it.
 */
function splitFamilyLinks(linksCell: string): {
  marriage: string[];
  bySpouseTag: Map<string, string[]>;
  spouseRecord: string[];
} {
  const marriage: string[] = [];
  const bySpouseTag = new Map<string, string[]>();
  const spouseRecord: string[] = [];
  for (const url of linksCell.split(",").map((s) => s.trim()).filter(Boolean)) {
    const site = recognizeSourceUrl(url);
    const tag = site && siteEventTag(site.site);
    if (tag) bySpouseTag.set(tag, [...(bySpouseTag.get(tag) ?? []), url]);
    else if (site && classifyBookType([site.proposed.title, site.collection]) === "marriage") marriage.push(url);
    else spouseRecord.push(url);
  }
  return { marriage, bySpouseTag, spouseRecord };
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
    const fatherId = father ? resolveRelative(people, father, `${prefix}F@`, "M") : undefined;
    const motherId = mother ? resolveRelative(people, mother, `${prefix}M@`, "F") : undefined;
    const fam = coupleFam(people, fatherId, motherId, `${prefix}FAM@`, true);
    addChild(fam.node, compareId);
    addPointer(people, compareId, "FAMC", fam.id);
  }

  // Partners: each entry is a family shared with this row's person. Only the
  // older "Žena:"/"Mož:" format says which spouse the partner is; without it the
  // row's own person takes the husband slot until something better is known.
  parseRelativeList(col(row, "partners")).forEach((partner, i) => {
    const mainIsWife = partner.role === "husband";
    const partnerSex = partner.role === "husband" ? "M" : partner.role === "wife" ? "F" : undefined;
    const partnerId = resolveRelative(people, partner, `${prefix}P${i + 1}@`, partnerSex);
    addSex(people, compareId, mainIsWife ? "F" : partner.role === "wife" ? "M" : undefined);
    const husbId = mainIsWife ? partnerId : compareId;
    const wifeId = mainIsWife ? compareId : partnerId;
    coupleFam(people, husbId, wifeId, `${prefix}PFAM${i + 1}@`, partner.role !== undefined);
  });
}

/**
 * Parse family rows, merging multiple rows for the same person into one
 * compare individual with multiple FAMS pointers (one per marriage). This way
 * a person who married more than once appears as a single match entry rather
 * than one per marriage.
 *
 * In a matches export (`paired`) a person is recognised across rows by the
 * main-side key, which names one person in the reader's file by definition. A
 * search export has only the incoming spelling to go by, and there a name
 * without a birth year is as likely two people as one — the rule the person
 * rows' relatives follow (see `dedupKey`) — so such a spouse stays their row's
 * own.
 */
function parseFamilyMatches(dataRows: string[][], index: Record<FamilyField, number>, paired: boolean): GiMatchesImport {
  const col = (row: string[], field: FamilyField): string => (row[index[field]] ?? "").trim();

  /** A person's identity across rows: the main-side key, or in a search export
   *  the incoming one, tagged with its row when no birth year backs it. */
  interface PersonKey extends GiMainKey {
    rowTag?: string;
  }
  /** Normalised dedup key: used to recognise the same person across rows. */
  const keyStr = (key: PersonKey): string => giPersonKey(key) + (key.rowTag ?? "");

  // ── Pass 1: collect all valid family row-pairs (or rows) ────────────────
  interface FamilyEntry {
    famIdx: number;
    incomingRow: string[];
    husbandKey: PersonKey;
    wifeKey: PersonKey;
  }
  const entries: FamilyEntry[] = [];
  let famCounter = 0;

  const step = paired ? 2 : 1;
  for (let i = 0; i + step - 1 < dataRows.length; i += step) {
    const keyRow = dataRows[i];
    const incomingRow = dataRows[i + step - 1];
    const husbandKey: PersonKey = {
      given: col(keyRow, "husbandName"),
      surname: stripSurnameAnnotation(col(keyRow, "husbandSurname")),
      birthYear: parseDate(withoutAnnotation(col(keyRow, "husbandBirth"))).year,
    };
    const wifeKey: PersonKey = {
      given: col(keyRow, "wifeName"),
      surname: stripSurnameAnnotation(col(keyRow, "wifeSurname")),
      birthYear: parseDate(withoutAnnotation(col(keyRow, "wifeBirth"))).year,
    };
    if (!husbandKey.given && !husbandKey.surname && !wifeKey.given && !wifeKey.surname) continue;
    famCounter++;
    if (!paired) {
      if (husbandKey.birthYear === undefined) husbandKey.rowTag = `#${famCounter}h`;
      if (wifeKey.birthYear === undefined) wifeKey.rowTag = `#${famCounter}w`;
    }
    entries.push({ famIdx: famCounter, incomingRow, husbandKey, wifeKey });
  }

  // ── Pass 2: assign one stable compare ID per unique main-side person ──
  let personCounter = 0;
  const personIdByKey = new Map<string, string>();
  const personMainKeyByKey = new Map<string, GiMainKey>();

  function getPersonId(key: PersonKey): string | undefined {
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
    /** From the column this person came from — a family row states both. */
    sex: Sex;
    father?: RelativeEntry;
    mother?: RelativeEntry;
  }
  const personAccs = new Map<string, PersonAcc>(); // compareId → acc

  function getAcc(
    key: PersonKey,
    given: string,
    surname: string,
    birth: string,
    sex: Sex,
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
        sex,
      });
    }
    return personAccs.get(compareId)!;
  }

  for (const { incomingRow, husbandKey, wifeKey } of entries) {
    const hacc = getAcc(husbandKey, col(incomingRow, "husbandName"), stripSurnameAnnotation(col(incomingRow, "husbandSurname")), col(incomingRow, "husbandBirth"), "M");
    if (hacc && !hacc.father && !hacc.mother) {
      hacc.father = parseRelativeList(col(incomingRow, "husbandFather"))[0];
      hacc.mother = parseRelativeList(col(incomingRow, "husbandMother"))[0];
    }
    const wacc = getAcc(wifeKey, col(incomingRow, "wifeName"), stripSurnameAnnotation(col(incomingRow, "wifeSurname")), col(incomingRow, "wifeBirth"), "F");
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
    const { compareId, mainKey, given, surname, birth, sex } = acc;
    const indiChildren: GedNode[] = [node(1, "NAME", `${given} /${surname}/`), node(1, "SEX", sex)];
    const dated = withoutAnnotation(birth ?? "");
    if (dated) indiChildren.push({ level: 1, tag: "BIRT", children: [node(2, "DATE", dated)] });
    addPerson(people, compareId, indiChildren);
    // Registered under the *incoming* spelling and birth year, which is what a
    // relative named in another row is written with — so a spouse who is also
    // someone's child or parent elsewhere lands on this record.
    claimKey(people, compareId, dedupKey(given, surname, dated ? parseDate(dated).year : undefined));
    pairs.push({ mainKey, compareId });
  }

  // ── Pass 5: marriages and the relatives named around them ────────────────
  for (const { famIdx, incomingRow, husbandKey, wifeKey } of entries) {
    // A family row names its two columns, so the spouse slots are asserted.
    const husbId = getPersonId(husbandKey);
    const wifeId = getPersonId(wifeKey);
    const fam = coupleFam(people, husbId, wifeId, `@${ID_PREFIX}FAM${famIdx}@`, true);
    const links = splitFamilyLinks(col(incomingRow, "links"));
    if (fam.fresh) {
      pushEvent(fam.node.children, "MARR", col(incomingRow, "marriageDate"), col(incomingRow, "marriagePlace"), links.marriage);
    }
    for (const id of [husbId, wifeId]) {
      if (!id) continue;
      for (const [tag, urls] of links.bySpouseTag) for (const url of urls) addEventLink(people, id, tag, url);
      for (const url of links.spouseRecord) addRecordLink(people, id, url);
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
    const fatherId = father ? resolveRelative(people, father, `${prefix}F@`, "M") : undefined;
    const motherId = mother ? resolveRelative(people, mother, `${prefix}M@`, "F") : undefined;
    const fam = coupleFam(people, fatherId, motherId, `${prefix}FAM@`, true);
    addChild(fam.node, compareId);
    addPointer(people, compareId, "FAMC", fam.id);
  }

  inferSexFromNames(people);
  settleGuessedRoles(people);
  if (!paired) return finish(people.records, undefined);
  for (const [compareId, mainKey] of people.relativeKeys) pairs.push({ mainKey, compareId });
  return finish(people.records, pairs);
}
