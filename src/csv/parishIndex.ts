/**
 * Import for the Slovenian parish-register index — the spreadsheet volunteers
 * fill in while reading a parish book on Matricula Online, one row per record,
 * and the shape hundreds of finished indexes are published in.
 *
 * Two kinds of book are indexed, each with its own columns:
 *
 *  - **P — marriages** (`datum poroke`, `ime/priimek ženina`, `ime/priimek
 *    neveste`): one row is a wedding, and becomes a couple with a `MARR`.
 *  - **K — baptisms** (`datum rojstva`, `datum krsta`, `ime otroka`, `ime/
 *    priimek očeta`, `ime/priimek matere`): one row is a child, and becomes an
 *    individual with a `BIRT`/`CHR` and the parents named beside them.
 *
 * The column *set* is not fixed. Files written years apart, by different
 * indexers, keep the same core and differ around it — the bride's address is
 * present in one parish and absent in the next, an alternate given name is
 * added, the abbreviation is written "alt. priimek" or "alt.priimek" or "alt
 * priimek", the order shifts. So the header is read by name rather than by
 * position: the columns we understand are taken wherever they stand, the rest
 * are ignored, and a file is recognised on its core alone.
 *
 * ## What the free-text `opombe` column contributes
 *
 * The notes column is the indexer's own prose, and the conventions vary by
 * hand: some files leave it empty, some write a remark ("vdova", "umrl
 * 17.9.1915"), and some write the register's whole entry in a regular form:
 *
 *     Ženin: vdovec, 42 let, kmet; starša Matija Jakofčič, kmet, in Barbara
 *     Simec. Nevesta: 32 let; starša Matija Križan, kmet, in Marija Milek.
 *     Priči: Matija Jakofčič, Miha Križan, kmeta.
 *
 * Where that form is followed it is read: the parents become real parent
 * families, an age at marriage becomes an approximate birth year, and the
 * witnesses become associations on the wedding. Where it is not, nothing is
 * extracted and nothing is guessed. Either way the note is carried verbatim
 * onto the event, because the reader's judgement is worth more than ours —
 * "preveri: priimek neveste" is the indexer telling us the surname is
 * uncertain, and no amount of parsing improves on showing them that sentence.
 */
import { buildDataset } from "../gedcom/builder";
import { parseDate } from "../gedcom/date";
import type { Dataset, GedNode, ParseResult, Sex } from "../gedcom/types";
import { sexFromGivenName } from "../gedcom/nameSex";
import { foldToken } from "../match/text";
import { parseCsvText } from "./csvText";
import {
  addChild,
  addPerson,
  addPointer,
  coupleFam,
  newPeople,
  node,
  type People,
  pushEvent,
} from "./people";

/** Prefix for the synthetic records produced from this import. */
const ID_PREFIX = "SPI";

// ── Columns ──────────────────────────────────────────────────────────────────

/** Every column we understand, in either book kind. */
type IndexField =
  | "parish"
  | "marriageDate"
  | "birthDate"
  | "baptismDate"
  | "address"
  | "brideAddress"
  | "groomGiven"
  | "groomAltGiven"
  | "groomSurname"
  | "groomAltSurname"
  | "brideGiven"
  | "brideAltGiven"
  | "brideSurname"
  | "brideAltSurname"
  | "childGiven"
  | "childAltGiven"
  | "childSurname"
  | "fatherGiven"
  | "fatherAltGiven"
  | "fatherSurname"
  | "fatherAltSurname"
  | "motherGiven"
  | "motherAltGiven"
  | "motherSurname"
  | "motherAltSurname"
  | "url"
  | "notes";

/**
 * Header label → field, on the label normalized by {@link normalizeLabel}. The
 * purely clerical columns (`zp. št.`, `številka`, `interpret`) are deliberately
 * absent: they say where in the book the record sits and who read it, which is
 * the index's own bookkeeping rather than anything about the people.
 */
const COLUMNS: Record<string, IndexField> = {
  "župnija": "parish",
  "datum poroke": "marriageDate",
  "datum rojstva": "birthDate",
  "datum krsta": "baptismDate",
  "naslov": "address",
  "naslov ženina": "address",
  "naslov neveste": "brideAddress",
  "ime ženina": "groomGiven",
  "alt ime ženina": "groomAltGiven",
  "priimek ženina": "groomSurname",
  "alt priimek ženina": "groomAltSurname",
  "ime neveste": "brideGiven",
  "alt ime neveste": "brideAltGiven",
  "priimek neveste": "brideSurname",
  "alt priimek neveste": "brideAltSurname",
  "ime otroka": "childGiven",
  "alt ime otroka": "childAltGiven",
  "priimek otroka": "childSurname",
  "ime očeta": "fatherGiven",
  "alt ime očeta": "fatherAltGiven",
  "priimek očeta": "fatherSurname",
  "alt priimek očeta": "fatherAltSurname",
  "ime matere": "motherGiven",
  "alt ime matere": "motherAltGiven",
  "priimek matere": "motherSurname",
  "alt priimek matere": "motherAltSurname",
  "url naslov": "url",
  "opombe": "notes",
};

/**
 * One header label reduced to the spelling {@link COLUMNS} is keyed by: lower
 * case, dots read as spaces and runs of blanks collapsed. That is what makes
 * "alt. priimek očeta", "alt.priimek očeta" and "alt priimek očeta" — three
 * spellings of one column across the published indexes — the same key.
 */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
}

/** Which book a file indexes. */
export type ParishIndexKind = "marriage" | "baptism";

export interface ParishIndexLayout {
  kind: ParishIndexKind;
  index: Partial<Record<IndexField, number>>;
}

/**
 * Read a header row as a parish-index layout, or `undefined` when it is not one.
 *
 * A file is recognised on its core columns alone — the parish, the record's own
 * date, and the names the record is about — so a parish that keeps one address
 * column and a parish that keeps two are both read, and so is a file with
 * columns we have never seen (they are simply ignored).
 */
export function detectParishIndex(header: string[]): ParishIndexLayout | undefined {
  const index: Partial<Record<IndexField, number>> = {};
  header.forEach((label, i) => {
    const field = COLUMNS[normalizeLabel(label)];
    // First column of a name wins: a duplicated header is a spreadsheet slip,
    // and the leftmost is the one the rows were filled under.
    if (field && index[field] === undefined) index[field] = i;
  });

  const has = (...fields: IndexField[]): boolean => fields.every((f) => index[f] !== undefined);
  if (index.parish === undefined) return undefined;
  if (has("marriageDate", "groomGiven", "groomSurname", "brideGiven", "brideSurname")) {
    return { kind: "marriage", index };
  }
  if (
    (index.birthDate !== undefined || index.baptismDate !== undefined) &&
    index.childGiven !== undefined &&
    (index.fatherSurname !== undefined || index.motherSurname !== undefined)
  ) {
    return { kind: "baptism", index };
  }
  return undefined;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * One date cell as a GEDCOM date value, or "" when the cell holds no date.
 *
 * The template asks for ISO (`1873-06-11`), which is what most files carry, but
 * a spreadsheet saved through a Slovenian locale writes `11.6.1873` and a
 * partly-legible entry is written down to whatever the page shows — a month, or
 * only a year. All four are read; anything else is kept only if the date parser
 * can make a year of it, so an indexer's "??" leaves the event undated rather
 * than dating it to nonsense.
 */
export function gedcomDate(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const ymd = (y: string, m: string, d?: string): string => {
    const month = MONTHS[Number(m) - 1];
    if (!month) return "";
    if (d === undefined) return `${month} ${y}`;
    const day = Number(d);
    if (day < 1 || day > 31) return "";
    return `${day} ${month} ${y}`;
  };
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(m[1], m[2], m[3]);
  m = v.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return ymd(m[1], m[2]);
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return ymd(m[3], m[2], m[1]);
  if (/^\d{4}$/.test(v)) return v;
  return parseDate(v).year !== undefined ? v : "";
}

/** The year a GEDCOM date value states, for the generation window and ages. */
function yearOf(gedDate: string): number | undefined {
  return gedDate ? parseDate(gedDate).year : undefined;
}

// ── The notes column ─────────────────────────────────────────────────────────

/** Which of a record's people a labelled stretch of the note describes. */
type NoteSubject = "groom" | "bride" | "child" | "witness" | "godparent";

/**
 * The note's section labels. A label is matched at a sentence or clause start,
 * not by a word boundary — JavaScript's `\b` is blind to "ž", so `\bŽenin`
 * never fires on the very word it was written for.
 */
const NOTE_LABELS: Array<{ words: string[]; subject: NoteSubject }> = [
  { words: ["ženin", "ženina"], subject: "groom" },
  { words: ["nevesta", "neveste"], subject: "bride" },
  { words: ["otrok", "otroka"], subject: "child" },
  { words: ["priči", "priča", "priče", "priče poroke"], subject: "witness" },
  { words: ["botra", "boter", "botri", "krstna botra", "krstni boter"], subject: "godparent" },
];

const LABEL_RE = new RegExp(
  `(?:^|[\\s.;,])(${NOTE_LABELS.flatMap((l) => l.words).join("|")})\\s*:`,
  "giu",
);

const SUBJECT_BY_WORD = new Map<string, NoteSubject>(
  NOTE_LABELS.flatMap((l) => l.words.map((w) => [w, l.subject] as const)),
);

/** Split a note into its labelled sections. Unlabelled prose belongs to nobody
 *  and is left alone — it is carried whole onto the event regardless. */
function noteSections(note: string): Map<NoteSubject, string> {
  const out = new Map<NoteSubject, string>();
  const marks: Array<{ subject: NoteSubject; start: number; from: number }> = [];
  LABEL_RE.lastIndex = 0;
  for (let m = LABEL_RE.exec(note); m; m = LABEL_RE.exec(note)) {
    const subject = SUBJECT_BY_WORD.get(m[1].toLowerCase());
    if (subject) marks.push({ subject, start: m.index, from: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : note.length;
    const text = note.slice(mark.from, Math.max(end, mark.from)).trim();
    // First mention wins: a second "Priči:" in one note is a continuation.
    if (text && !out.has(mark.subject)) out.set(mark.subject, text);
  });
  return out;
}

/**
 * Drop the register's shorthand for "deceased" and "née" — `†`, `+`, `pok.`,
 * `pokojni`, `r.`, `roj.` — before a name is read out of the prose.
 *
 * They go first because they are also where the abbreviation dots are: leaving
 * them in, "in pok. Marija Simec" ends its sentence at "pok." and the mother of
 * the record comes out named "pok".
 */
function withoutRegisterMarks(text: string): string {
  return text
    .replace(/[†✝](\s*)/gu, "$1")
    .replace(/(^|[\s(,;])\+\s+(?=\p{Lu})/gu, "$1")
    .replace(/(^|[\s(,;])(?:pok|r|roj|rodj)\.\s*/giu, "$1")
    .replace(/(^|[\s(,;])(?:pokojn[aeiu]\w*|rojena|rojen)\s+/giu, "$1")
    .replace(/\s{2,}/g, " ");
}

/** The clause a parents/witness list occupies: up to the sentence that ends it. */
function firstClause(text: string): string {
  const at = text.search(/[.;]/);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/**
 * One personal name read out of prose: the leading run of capitalised words,
 * two or three of them.
 *
 * The register writes a name and then what the person was — "Marija Skubic iz
 * Črnomlja, meščanka, vdova", "Anton Kure, kmet" — and the lower-case word that
 * starts the description is exactly where the name stops. Requiring two
 * capitalised words is what keeps a trailing occupation ("kmeta", "nožar") and
 * a bare place out of the file as people.
 */
function nameFromProse(raw: string): string | undefined {
  const words = withoutRegisterMarks(raw).trim().split(/\s+/);
  const taken: string[] = [];
  for (const word of words) {
    const clean = word.replace(/^[("»]+|[)",.;»«]+$/gu, "");
    if (!clean || !/^\p{Lu}/u.test(clean) || /\d/.test(clean)) break;
    taken.push(clean);
    if (taken.length === 3) break;
  }
  return taken.length >= 2 ? taken.join(" ") : undefined;
}

/** What one person's stretch of the note says about them. */
interface NotePerson {
  /** Age in years at the record's own event, when the note states one. */
  age?: number;
  father?: string;
  mother?: string;
}

/** Where a parents clause starts, and which parents it names. */
const PARENTS_RE = /(?:^|[\s.;,])(starša|starši|mati|oče|očeta)\s+/iu;

/**
 * Read one person's section of the note: their age, and the parents the
 * register names for them.
 *
 * The age is looked for only *before* the parents clause. A note reads "Ženin:
 * 25 let; starša Martin Orlič, kmet, in Ana Logar" and the parents' own
 * description can carry a number of years too — searching the whole section
 * would sooner or later give the groom his father's age.
 */
export function parseNotePerson(section: string): NotePerson {
  const at = section.search(PARENTS_RE);
  const head = at >= 0 ? section.slice(0, at) : section;
  const out: NotePerson = {};

  const age = head.match(/(\d{1,2})\s*let\b/u);
  if (age) {
    const years = Number(age[1]);
    // A marrying or newly-baptised person is neither an infant nor a centenarian;
    // a number outside that is a house number or a year the sentence lost.
    if (years >= 12 && years <= 99) out.age = years;
  }

  if (at < 0) return out;
  const marker = section.slice(at).match(PARENTS_RE)!;
  const keyword = marker[1].toLowerCase();
  const clause = firstClause(withoutRegisterMarks(section.slice(at + marker[0].length)));

  if (keyword === "mati") {
    out.mother = nameFromProse(clause);
    return out;
  }
  if (keyword === "oče" || keyword === "očeta") {
    out.father = nameFromProse(clause);
    return out;
  }

  // "starša <father> in <mother>" — the comma form ("…, kmet, in Barbara Simec")
  // is looked for first, because the plain " in " it ends with would otherwise
  // split the father's own description off as the mother.
  const comma = clause.indexOf(", in ");
  const split = comma >= 0 ? { at: comma, len: 5 } : matchWord(clause, /\sin\s/u);
  if (!split) {
    out.father = nameFromProse(clause);
    return out;
  }
  out.father = nameFromProse(clause.slice(0, split.at));
  out.mother = nameFromProse(clause.slice(split.at + split.len));
  return out;
}

function matchWord(text: string, re: RegExp): { at: number; len: number } | undefined {
  const m = text.match(re);
  return m?.index === undefined ? undefined : { at: m.index, len: m[0].length };
}

/**
 * The people a witness/godparent section names. The list runs until the
 * sentence ends, so the remarks that follow it — a court's marriage consent,
 * the indexer's "preveri:" — contribute nobody.
 */
export function parseAssociates(section: string): string[] {
  const clause = firstClause(withoutRegisterMarks(section));
  const names: string[] = [];
  for (const part of clause.split(/,| in /u)) {
    const name = nameFromProse(part);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// ── Building the records ─────────────────────────────────────────────────────

/** A person as the columns or the prose name them. */
interface NamedPerson {
  given: string;
  surname: string;
  altGiven?: string;
  altSurname?: string;
}

/**
 * One parent couple already built, and the birth years of the children the
 * index has given them so far — see {@link SIBLING_WINDOW}.
 */
interface CoupleEntry {
  fam: GedNode;
  minYear?: number;
  maxYear?: number;
}

interface ParishIndexContext {
  people: People;
  /** Serial for every synthetic id, so individuals and families never collide. */
  n: number;
  couples: Map<string, CoupleEntry[]>;
}

/**
 * How many years of births one couple's children may span.
 *
 * A parent couple is recognised across rows by their two names — that is what
 * turns the brides of 1874 and 1879 into sisters, and every child in a baptism
 * book into somebody's sibling, which is most of what importing an index is
 * worth. Over a book spanning a century, though, the same two names are
 * eventually a different couple: a grandson marries a woman named as his
 * grandmother was, and their children join his parents' family.
 *
 * One woman bears children over some twenty-five years at the very outside, so
 * a couple only absorbs a child whose birth keeps their whole span inside this
 * window; a child born outside it starts a second couple of the same name.
 * Judging it by *births* is what makes the two book kinds comparable — a
 * marriage index dates weddings, and a couple's children wed over a longer
 * stretch than they were born over, because the eldest marries while the
 * youngest is still a child.
 */
const SIBLING_WINDOW = 30;

/** Stand-in age for a marriage row whose note states none. */
const TYPICAL_MARRYING_AGE = 25;

function newId(ctx: ParishIndexContext, kind: "I" | "F"): string {
  ctx.n++;
  return `@${ID_PREFIX}${kind}${ctx.n}@`;
}

/** The INDI children a named person gets: their name, the spellings the index
 *  records beside it, and their sex when the record states it outright. */
function personChildren(person: NamedPerson, sex: Sex | undefined): GedNode[] {
  const children: GedNode[] = [node(1, "NAME", `${person.given} /${person.surname}/`)];
  // An alternate spelling is a name of its own — the German or Italian form the
  // register used, or the second given name — so it is written as a `TYPE aka`
  // NAME record and reshaped to whatever the main file does with such names.
  const alts: string[] = [];
  if (person.altSurname) alts.push(`${person.given} /${person.altSurname}/`);
  if (person.altGiven) alts.push(`${person.altGiven} /${person.surname}/`);
  for (const value of alts) {
    if (value === children[0].value) continue;
    children.push({
      level: 1,
      tag: "NAME",
      value,
      children: [node(2, "TYPE", "aka")],
    });
  }
  if (sex) children.push(node(1, "SEX", sex));
  return children;
}

function addNamed(ctx: ParishIndexContext, person: NamedPerson, sex: Sex | undefined): string {
  const id = newId(ctx, "I");
  addPerson(ctx.people, id, personChildren(person, sex));
  return id;
}

/** Fold a name to the spelling the couple registry recognises it by. */
function nameKey(person: NamedPerson | undefined): string {
  return person ? `${foldToken(person.given)} ${foldToken(person.surname)}` : "";
}

/**
 * The family of a record's parents: the one an earlier row of the same parish
 * already built for these two names, or a fresh one.
 *
 * Returns nothing when the index names neither parent — there is no family to
 * speak of, and a childless FAM record only clutters the review.
 */
function parentFamily(
  ctx: ParishIndexContext,
  parish: string,
  father: NamedPerson | undefined,
  mother: NamedPerson | undefined,
  /** When the child of this record was born, as near as the index says. */
  born: number | undefined,
): GedNode | undefined {
  if (!father && !mother) return undefined;
  const key = `${foldToken(parish)}|${nameKey(father)}|${nameKey(mother)}`;
  const entries = ctx.couples.get(key) ?? [];

  const fits = entries.find((e) => {
    if (born === undefined || e.minYear === undefined || e.maxYear === undefined) return true;
    return Math.max(e.maxYear, born) - Math.min(e.minYear, born) <= SIBLING_WINDOW;
  });
  if (fits) {
    if (born !== undefined) {
      fits.minYear = Math.min(fits.minYear ?? born, born);
      fits.maxYear = Math.max(fits.maxYear ?? born, born);
    }
    return fits.fam;
  }

  const fatherId = father ? addNamed(ctx, father, "M") : undefined;
  const motherId = mother ? addNamed(ctx, mother, "F") : undefined;
  // The columns and the prose both say which parent is which, so the spouse
  // slots are asserted rather than guessed.
  const fam = coupleFam(ctx.people, fatherId, motherId, newId(ctx, "F"), true);
  entries.push({ fam: fam.node, minYear: born, maxYear: born });
  ctx.couples.set(key, entries);
  return fam.node;
}

/** Attach a record's people-who-are-not-relatives to the event that names them. */
function associationNodes(names: string[], role: "WITN" | "GODP"): GedNode[] {
  // `@VOID@` is GEDCOM's "a person this file does not record": the index names
  // the witnesses but indexes nothing else about them, and minting a person per
  // witness would flood the compare file with records nobody can match.
  return names.map((name) => ({
    level: 2,
    tag: "ASSO",
    value: "@VOID@",
    children: [node(3, "PHRASE", name), node(3, "ROLE", role)],
  }));
}

/** The residence a record's address states, dated to the record's own event. */
function residence(address: string, date: string): GedNode | undefined {
  if (!address) return undefined;
  const children: GedNode[] = [];
  if (date) children.push(node(2, "DATE", date));
  children.push(node(2, "PLAC", address));
  return { level: 1, tag: "RESI", children };
}

// ── The import ───────────────────────────────────────────────────────────────

export interface ParishIndexImport {
  dataset: Dataset;
  kind: ParishIndexKind;
  /** How many CSV rows became records — the rest were blank or unnamed. */
  rows: number;
}

/**
 * Parse a parish-register index CSV into a synthetic compare `Dataset`.
 *
 * Unlike the genealogical-index matches CSV, an index of a parish book says
 * nothing about which of the reader's people it concerns — it is a whole
 * register, not a list of matches — so it is handed to the ordinary matching
 * engine exactly as a GEDCOM compare file would be.
 *
 * Returns `undefined` when the header is not a parish index, so the caller can
 * try the other CSV shapes it knows.
 */
export function parseParishIndexCsv(text: string): ParishIndexImport | undefined {
  return parseParishIndexRows(parseCsvText(text));
}

/**
 * The same, from rows already read — one sheet of a workbook, or a parsed CSV.
 * Returns `undefined` when the first row is not a parish-index header.
 */
export function parseParishIndexRows(table: string[][]): ParishIndexImport | undefined {
  const rows = table.filter((r) => r.some((cell) => cell.trim()));
  if (!rows.length) return undefined;
  const layout = detectParishIndex(rows[0]);
  if (!layout) return undefined;

  const ctx: ParishIndexContext = {
    people: newPeople(),
    n: 0,
    couples: new Map(),
  };

  const cell = (row: string[], field: IndexField): string => {
    const at = layout.index[field];
    return at === undefined ? "" : (row[at] ?? "").trim();
  };

  let built = 0;
  for (const row of rows.slice(1)) {
    const made = layout.kind === "marriage" ? marriageRow(ctx, row, cell) : baptismRow(ctx, row, cell);
    if (made) built++;
  }
  return { dataset: finish(ctx.people.records), kind: layout.kind, rows: built };
}

type Cell = (row: string[], field: IndexField) => string;

/** A person from the columns, or nothing when the index names neither part. */
function columnPerson(
  row: string[],
  cell: Cell,
  given: IndexField,
  surname: IndexField,
  altGiven: IndexField,
  altSurname: IndexField,
): NamedPerson | undefined {
  const person: NamedPerson = {
    given: cell(row, given),
    surname: cell(row, surname),
    altGiven: cell(row, altGiven) || undefined,
    altSurname: cell(row, altSurname) || undefined,
  };
  return person.given || person.surname ? person : undefined;
}

/** A parent the prose names, as a person the file can record. */
function proseParent(full: string | undefined): NamedPerson | undefined {
  if (!full) return undefined;
  const at = full.lastIndexOf(" ");
  if (at < 0) return undefined;
  return { given: full.slice(0, at).trim(), surname: full.slice(at + 1).trim() };
}

/** An approximate birth year from an age at a dated event. */
function birthFromAge(age: number | undefined, eventYear: number | undefined): GedNode | undefined {
  if (age === undefined || eventYear === undefined) return undefined;
  // "ABT" and not a bare year on purpose: an age in whole years places the birth
  // across two calendar years, and the matcher reads an approximate date with
  // the tolerance that deserves.
  return { level: 1, tag: "BIRT", children: [node(2, "DATE", `ABT ${eventYear - age}`)] };
}

function marriageRow(ctx: ParishIndexContext, row: string[], cell: Cell): boolean {
  const groom = columnPerson(row, cell, "groomGiven", "groomSurname", "groomAltGiven", "groomAltSurname");
  const bride = columnPerson(row, cell, "brideGiven", "brideSurname", "brideAltGiven", "brideAltSurname");
  if (!groom && !bride) return false;

  const parish = cell(row, "parish");
  const date = gedcomDate(cell(row, "marriageDate"));
  const year = yearOf(date);
  const notes = cell(row, "notes");
  const sections = notes ? noteSections(notes) : new Map<NoteSubject, string>();

  const groomNote = parseNotePerson(sections.get("groom") ?? "");
  const brideNote = parseNotePerson(sections.get("bride") ?? "");

  // The bride's address has a column of its own only in the later files; where
  // there is one address it is the house the record is filed under, the groom's.
  const groomAddress = cell(row, "address");
  const brideAddress = cell(row, "brideAddress");

  const spouseId = (
    person: NamedPerson | undefined,
    sex: Sex,
    note: NotePerson,
    address: string,
  ): string | undefined => {
    if (!person) return undefined;
    const id = addNamed(ctx, person, sex);
    const record = ctx.people.indi.get(id)!;
    const birth = birthFromAge(note.age, year);
    if (birth) record.children.push(birth);
    const resi = residence(address, date);
    if (resi) record.children.push(resi);
    return id;
  };

  const groomId = spouseId(groom, "M", groomNote, groomAddress);
  const brideId = spouseId(bride, "F", brideNote, brideAddress);

  const fam = coupleFam(ctx.people, groomId, brideId, newId(ctx, "F"), true);
  const extra: GedNode[] = [
    ...associationNodes(parseAssociates(sections.get("witness") ?? ""), "WITN"),
    ...(notes ? [node(2, "NOTE", notes)] : []),
  ];
  pushEvent(fam.node.children, "MARR", date, parish, links(cell(row, "url")), extra);

  attachParents(ctx, parish, groomId, groomNote, year);
  attachParents(ctx, parish, brideId, brideNote, year);
  return true;
}

function baptismRow(ctx: ParishIndexContext, row: string[], cell: Cell): boolean {
  const father = columnPerson(row, cell, "fatherGiven", "fatherSurname", "fatherAltGiven", "fatherAltSurname");
  const mother = columnPerson(row, cell, "motherGiven", "motherSurname", "motherAltGiven", "motherAltSurname");

  const given = cell(row, "childGiven");
  // The baptism index gives the child no surname of its own: it is the father's,
  // and the mother's where the register names no father.
  const surname = cell(row, "childSurname") || father?.surname || mother?.surname || "";
  if (!given && !surname) return false;

  const parish = cell(row, "parish");
  const birthDate = gedcomDate(cell(row, "birthDate"));
  const baptismDate = gedcomDate(cell(row, "baptismDate"));
  const year = yearOf(birthDate) ?? yearOf(baptismDate);
  const notes = cell(row, "notes");
  const sections = notes ? noteSections(notes) : new Map<NoteSubject, string>();

  const child: NamedPerson = {
    given,
    surname,
    altGiven: cell(row, "childAltGiven") || undefined,
    altSurname: cell(row, "childSurname") ? undefined : father?.altSurname,
  };
  const childId = addNamed(ctx, child, sexFromGivenName(given));
  const record = ctx.people.indi.get(childId)!;

  // The address is the house the child was born in, so it is the birth's place
  // rather than a residence of its own: a house number two records share is the
  // strongest thing a parish index says about who is who.
  pushEvent(record.children, "BIRT", birthDate, cell(row, "address"));
  const extra: GedNode[] = [
    ...associationNodes(parseAssociates(sections.get("godparent") ?? ""), "GODP"),
    ...associationNodes(parseAssociates(sections.get("witness") ?? ""), "WITN"),
    ...(notes ? [node(2, "NOTE", notes)] : []),
  ];
  pushEvent(record.children, "CHR", baptismDate, parish, links(cell(row, "url")), extra);

  const fam = parentFamily(ctx, parish, father, mother, year);
  if (fam) {
    addChild(fam, childId);
    addPointer(ctx.people, childId, "FAMC", fam.xref!);
  }
  return true;
}

/**
 * Wire a spouse to the parents their note names, under the year they were born
 * rather than the year they wed — see {@link SIBLING_WINDOW}. An age gives that
 * year outright; without one, the register is only told that this was somebody
 * of marrying age, and {@link TYPICAL_MARRYING_AGE} stands in for it.
 */
function attachParents(
  ctx: ParishIndexContext,
  parish: string,
  childId: string | undefined,
  note: NotePerson,
  marriageYear: number | undefined,
): void {
  if (!childId) return;
  const born =
    marriageYear === undefined ? undefined : marriageYear - (note.age ?? TYPICAL_MARRYING_AGE);
  const fam = parentFamily(ctx, parish, proseParent(note.father), proseParent(note.mother), born);
  if (!fam) return;
  addChild(fam, childId);
  addPointer(ctx.people, childId, "FAMC", fam.xref!);
}

/** The links one URL cell holds. */
function links(cell: string): string[] {
  return cell.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

function finish(records: GedNode[]): Dataset {
  const parsed: ParseResult = {
    version: "5.5.1",
    charset: "UTF-8",
    records,
    warnings: [],
    eol: "\n",
    finalNewline: true,
  };
  const dataset = buildDataset(parsed);
  // A parish index dates the record, not the people in it: a marriage row gives
  // its couple only an age-derived year, and the parents it names no date at
  // all. Let matching use the marriage-plausibility fallback for those instead
  // of charging them the missing-birth-key penalty.
  dataset.sparseBirthDates = true;
  return dataset;
}
