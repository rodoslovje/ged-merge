/**
 * Reading a spreadsheet workbook (`.xlsx` / `.xlsm`) as rows of text.
 *
 * The parish indexes are published as workbooks, not CSV — hundreds of them,
 * in zip files — so asking the reader to open each one and save it again just
 * to hand it over is a step worth removing. A workbook is a zip of XML, and
 * both halves of that are already at hand: {@link zipEntries} opens the zip
 * (the same reader the geo registers arrive through), and the sheet XML a
 * spreadsheet writes is regular enough to scan directly. Nothing here is a
 * general spreadsheet library — no formulas, no styles, no formatting — only
 * enough to turn a sheet into the `string[][]` an importer reads.
 *
 * Two things a workbook does that a CSV never does, and both are handled:
 * text is pooled in one shared table and referenced by number, and a row
 * writes only its non-empty cells, each naming the column it sits in.
 */
import { zipEntries, zipEntryStream, type ZipEntry } from "../geo/zip";

export interface WorkbookSheet {
  /** The sheet's tab name, as the workbook lists it. */
  name: string;
  rows: string[][];
}

/** Whether a buffer is a zip container at all — every workbook begins "PK". */
export function looksLikeWorkbook(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b;
}

/**
 * Every sheet of a workbook, in the order its tabs are shown.
 *
 * Tab order is the workbook's own, which is not the order the sheet files are
 * numbered in: the published index templates carry an instructions tab and a
 * list of given names beside the index itself, and which of them is
 * `sheet1.xml` differs from file to file. Reading the relationship table is
 * what keeps a sheet's name attached to its contents.
 *
 * Returns an empty list for a zip that is not a workbook.
 */
export async function readWorkbook(buffer: ArrayBuffer): Promise<WorkbookSheet[]> {
  const entries = new Map(zipEntries(buffer).map((e) => [e.name, e]));
  const workbookXml = await entryText(buffer, entries.get("xl/workbook.xml"));
  if (!workbookXml) return [];

  const shared = sharedStrings(await entryText(buffer, entries.get("xl/sharedStrings.xml")));
  const targets = relationshipTargets(await entryText(buffer, entries.get("xl/_rels/workbook.xml.rels")));

  const sheets: WorkbookSheet[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = decodeXmlText(attribute(attrs, "name") ?? "");
    const id = attribute(attrs, "r:id") ?? attribute(attrs, "relationshipId");
    const target = id ? targets.get(id) : undefined;
    const entry = target ? entries.get(sheetPath(target)) : undefined;
    if (!entry) continue;
    sheets.push({ name, rows: sheetRows(await entryText(buffer, entry), shared) });
  }
  return sheets;
}

/** A relationship target resolved to its path inside the zip. Targets are
 *  written relative to `xl/`, or absolutely from the package root. */
function sheetPath(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
}

async function entryText(buffer: ArrayBuffer, entry: ZipEntry | undefined): Promise<string> {
  if (!entry) return "";
  return new Response(zipEntryStream(buffer, entry)).text();
}

function attribute(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name.replace(":", "\\:")}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function relationshipTargets(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attribute(m[1], "Id");
    const target = attribute(m[1], "Target");
    if (id && target) out.set(id, decodeXmlText(target));
  }
  return out;
}

/**
 * The workbook's pooled text, indexed as the cells reference it.
 *
 * One pooled string can be several runs — a cell whose text was written in two
 * fonts is stored as `<si><r><t>Marija </t></r><r><t>Kralj</t></r></si>` — so
 * a string is every `<t>` under its own `<si>` joined, never one `<t>` each.
 * Counting the runs instead would shift every index past the first such cell
 * and rename half the file's people.
 */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(textOf(m[1] ?? ""));
  return out;
}

/** The text of an element that holds `<t>` runs. */
function textOf(xml: string): string {
  // Phonetic runs (`<rPh>`) spell out how a word is read and are not part of
  // the value; they carry `<t>` of their own, which would otherwise be appended.
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += decodeXmlText(m[1] ?? "");
  return text;
}

const ROW_RE = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/**
 * One sheet's cells as rows of text.
 *
 * A spreadsheet writes only the cells that hold something, each naming its own
 * column ("D7"), so the gaps have to be put back: read positionally, a row
 * whose third column is blank would hand every later value to the wrong
 * column, and an index whose bride column is empty in one row would marry the
 * groom to a house number.
 */
function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(ROW_RE)) {
    const cells: string[] = [];
    let previous = -1;
    for (const cell of (row[1] ?? "").matchAll(CELL_RE)) {
      const attrs = cell[1] ?? "";
      const ref = attribute(attrs, "r");
      const at = ref ? columnOf(ref) : previous + 1;
      if (at < 0) continue;
      previous = at;
      while (cells.length <= at) cells.push("");
      cells[at] = cellText(attrs, cell[2] ?? "", shared);
    }
    rows.push(cells);
  }
  return rows;
}

/** The column a cell reference names: "A" → 0, "B" → 1, … "AA" → 26. */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break; // the row number, past the column letters
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/**
 * One cell's value as text.
 *
 * Numbers are handed back as the sheet writes them, and dates in these files
 * are text rather than numbers: a spreadsheet counts dates from 1900 and so
 * cannot hold a parish register's at all, which is why the indexers type them
 * (`1873-06-11`). {@link gedcomDate} reads them from there.
 */
function cellText(attrs: string, inner: string, shared: string[]): string {
  const type = attribute(attrs, "t") ?? "n";
  if (type === "inlineStr") return textOf(inner);
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inner);
  const raw = v?.[1];
  if (raw === undefined) return "";
  if (type === "s") return shared[Number(raw)] ?? "";
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "e") return ""; // an error cell (#REF!, #N/A) states nothing
  return decodeXmlText(raw);
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
