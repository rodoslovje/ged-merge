import { parseCsvText } from "../csv/csvText";
import { foldToken } from "../match/text";
import { getFormerStreets } from "../persist/geoDb";
import { sameStreet } from "./addressRegister";

// Former street names — the table that lets an address written under a name a
// town has since changed still find its house.
//
// An address register describes the streets as they are called today. A parish
// record or a census sheet names them as they were called then: "Aleksandrova
// cesta 5" in the Ljubljana of 1930 is a house on what the register knows only
// as Cankarjeva cesta. Asked as written, the register answers nothing — or,
// worse, answers with a different street that has since taken the old name
// (the Šmartinska cesta of 1876 is today's Njegoševa cesta, and there is a
// Šmartinska cesta elsewhere in the city now).
//
// The table is not shipped with the app: whoever wants it loads a CSV file,
// which is stored in this browser like every other directory. One row is one
// name a street bore for a while:
//
//   settlement,former_name,from,to,current_name
//   Ljubljana,Aleksandrova cesta,1919,1941,Cankarjeva cesta
//
// `settlement` and `current_name` are the register's own spellings, since they
// are what the register is then asked with. The years are optional and are
// shown to the researcher rather than acted on: the same old name was given to
// different streets at different times, and which one a record means is theirs
// to decide.

/** One name a street bore for a while. */
export interface FormerStreet {
  /** The settlement the street is in, as the register names it. */
  settlement: string;
  /** The name it bore. */
  former: string;
  /** The year it was given that name, when known. */
  from?: number;
  /** The year it lost it, when known. */
  to?: number;
  /** What the register calls the street today. */
  current: string;
}

/** The stored table: its rows and when they were loaded. */
export interface FormerStreetTable {
  entries: FormerStreet[];
  importedAt: number;
}

/** A former name a register answer was found under — what tells the researcher
 *  that the house offered stands on a street the file names differently. */
export interface FormerName {
  name: string;
  from?: number;
  to?: number;
}

const COLUMNS = ["settlement", "former_name", "from", "to", "current_name"] as const;

function year(cell: string | undefined): number | undefined {
  const n = Number(cell?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Read a former-street-names CSV. Undefined when the file is not one — its
 * header lacks a column the table cannot do without — so the caller can say so
 * rather than store an empty table. Rows missing a name are skipped.
 */
export function parseFormerStreets(text: string): FormerStreet[] | undefined {
  const [header, ...rows] = parseCsvText(text);
  if (!header) return undefined;
  const names = header.map((h) => h.trim().toLowerCase());
  const at = Object.fromEntries(COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  if (at.settlement < 0 || at.former_name < 0 || at.current_name < 0) return undefined;
  const out: FormerStreet[] = [];
  for (const row of rows) {
    const settlement = row[at.settlement]?.trim();
    const former = row[at.former_name]?.trim();
    const current = row[at.current_name]?.trim();
    if (!settlement || !former || !current) continue;
    const from = year(row[at.from]);
    const to = year(row[at.to]);
    out.push({ settlement, former, ...(from ? { from } : {}), ...(to ? { to } : {}), current });
  }
  return out;
}

/**
 * The streets a written name once belonged to, in any of the settlements the
 * address may sit in. The written name is compared the way a register street is
 * ({@link sameStreet}), so the file's "Aleksandrova" finds the table's
 * "Aleksandrova cesta".
 *
 * A row whose current name is the written one is left out: that street is
 * what the lookup as written already asks for.
 */
export function formerStreetsOf(
  table: readonly FormerStreet[],
  street: string,
  settlements: readonly string[],
): FormerStreet[] {
  if (!table.length) return [];
  const wanted = new Set(settlements.map(foldToken).filter(Boolean));
  const folded = foldToken(street);
  return table.filter(
    (e) =>
      wanted.has(foldToken(e.settlement)) &&
      sameStreet(street, e.former, folded) &&
      !sameStreet(street, e.current, folded),
  );
}

/** The settlements a table covers, for saying what was loaded: "Ljubljana", or
 *  the first few of a longer list. */
export function formerStreetPlaces(table: readonly FormerStreet[]): string {
  const names = [...new Set(table.map((e) => e.settlement))];
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
}

/** "Aleksandrova cesta (1919–1941)" — the name and the years it was borne, as
 *  far as the table knows them. Wordless, so it reads the same in every
 *  language. */
export function formerNameLabel(former: FormerName): string {
  if (!former.from && !former.to) return former.name;
  return `${former.name} (${former.from ?? ""}–${former.to ?? ""})`;
}

// --- The stored table, read once per session --------------------------------

let loading: Promise<readonly FormerStreet[]> | undefined;

/** The table this browser holds — empty when none was loaded, or when the store
 *  cannot be read, which every lookup takes as "no former names known". */
export function storedFormerStreets(): Promise<readonly FormerStreet[]> {
  loading ??= getFormerStreets()
    .then((table) => table?.entries ?? [])
    .catch(() => []);
  return loading;
}

/** Forget the table read — called when one is loaded or removed. */
export function invalidateFormerStreets(): void {
  loading = undefined;
}
