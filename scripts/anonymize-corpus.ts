/**
 * Anonymized test-corpus generator.
 *
 * Turns the real production GEDCOMs in `test-data/` into a small, committable,
 * PRIVACY-SCRUBBED fixture set under `src/__fixtures__/corpus/`, deliberately
 * spanning the exporter / charset / GEDCOM-version matrix so the round-trip,
 * decode and normalize tests exercise real-world quirks.
 *
 * What is PRESERVED (the format fingerprint the fixtures exist to test):
 *   - every tag, record structure, level nesting, CONT/CONC folding
 *   - dates exactly as written (JAN 1900 / 1.1.1900 / 1900-01-01 …)
 *   - place names & structure (house numbers etc.)
 *   - source/citation titles & links (Matricula/Geneanet URLs)
 *   - original line-endings, final-newline, and character encoding
 *     (Windows-1250 stays Windows-1250 bytes → decode.ts detection is tested)
 *
 * What is SCRUBBED (per the agreed "names + free text + contacts" scope):
 *   - personal names on NAME / GIVN / SURN / NICK / _MARNM / _AKA (consistent
 *     pseudonyms: the same real name always maps to the same fake one, so
 *     family groupings survive)
 *   - NOTE / TEXT free-text narrative → placeholder of similar shape
 *   - email / phone / fax contact lines
 *   - submitter (HEAD/SUBM) name & postal address
 *   - OBJE/FILE media paths (often contain a local user directory)
 *
 * Deliberately KEPT even though arguably personal: place names (needed for
 * place-format tests; geography alone is not identifying) and bibliographic
 * SOUR TITL/AUTH/PUBL (needed for citation-format tests).
 *
 * Run:  node scripts/anonymize-corpus.ts
 * Node 24+ strips the TS types natively — no build step, no extra deps.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GIVEN_NAMES, SURNAMES, STEM_SIZE } from "../src/__fixtures__/pseudonyms.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_DIR = resolve(ROOT, "test-data");
const OUT_DIR = resolve(ROOT, "src/__fixtures__/corpus");

type Charset = "utf-8" | "windows-1250";

interface Spec {
  src: string;
  out: string;
  charset: Charset;
  /** Human-readable fingerprint recorded in the manifest. */
  exporter: string;
  version: string;
  /** Rough byte budget of kept INDI records before referenced records are added. */
  indiBudget?: number;
  note?: string;
}

// A curated slice of the corpus spanning exporters × charsets × GEDCOM versions.
const SPECS: Spec[] = [
  { src: "Carrozza.ged", out: "ancestry-5.5.1-utf8.ged", charset: "utf-8", exporter: "Ancestry.com Family Trees", version: "5.5.1" },
  { src: "Florjančič.ged", out: "rootsmagic-5.5.1-utf8.ged", charset: "utf-8", exporter: "RootsMagic", version: "5.5.1" },
  { src: "Mali.ged", out: "familyhistorian-5.5.1-utf8.ged", charset: "utf-8", exporter: "Family Historian 7", version: "5.5.1" },
  { src: "Trstenjak.ged", out: "familyhistorian-5.5.1-w1250.ged", charset: "windows-1250", exporter: "Family Historian 7 (ANSI)", version: "5.5.1" },
  { src: "Modrijan.ged", out: "brotherskeeper-5.5.1-w1250.ged", charset: "windows-1250", exporter: "Brother's Keeper", version: "5.5.1" },
  { src: "Novaković.ged", out: "brotherskeeper-5.5-w1250.ged", charset: "windows-1250", exporter: "Brother's Keeper", version: "5.5", note: "GEDCOM 5.5 (not 5.5.1)" },
  { src: "Herman.ged", out: "geneanet-5.5.1-utf8.ged", charset: "utf-8", exporter: "Geneanet", version: "5.5.1" },
  { src: "Odar.ged", out: "geneanet-5.5.1-w1250.ged", charset: "windows-1250", exporter: "Geneanet (ANSI)", version: "5.5.1" },
  { src: "Martelak.ged", out: "gramps-5.5.1-utf8.ged", charset: "utf-8", exporter: "Gramps", version: "5.5.1" },
  { src: "Mauko-M.ged", out: "myheritage-5.5.1-utf8.ged", charset: "utf-8", exporter: "MyHeritage", version: "5.5.1" },
  { src: "Sajovic.ged", out: "webtrees-5.5.1-utf8.ged", charset: "utf-8", exporter: "webtrees", version: "5.5.1" },
  { src: "Senen.ged", out: "reunion-5.5.1-utf8.ged", charset: "utf-8", exporter: "Reunion", version: "5.5.1" },
  { src: "Renko.ged", out: "synium-7.0-utf8.ged", charset: "utf-8", exporter: "Synium MacFamilyTree", version: "7.0", note: "GEDCOM 7.0" },
  { src: "Bandelj.ged", out: "unknown-5.5.1-utf8.ged", charset: "utf-8", exporter: "(no HEAD.SOUR)", version: "5.5.1", note: "HEAD without a SOUR line" },
];

const INDI_BUDGET_DEFAULT = 55_000; // bytes of kept INDI records before 1-hop refs

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Build a reverse (char → byte) table for a single-byte codepage. */
function buildEncoder(charset: Charset): (s: string) => Uint8Array {
  if (charset === "utf-8") {
    const enc = new TextEncoder();
    return (s) => enc.encode(s);
  }
  const dec = new TextDecoder(charset, { fatal: false });
  const charToByte = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (ch !== "�" && !charToByte.has(ch)) charToByte.set(ch, b);
  }
  return (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = ch.charCodeAt(0);
      out[i] = code < 0x80 ? code : (charToByte.get(ch) ?? 0x3f /* '?' */);
    }
    return out;
  };
}

function decode(buf: Buffer, charset: Charset): { text: string; eol: string; finalNewline: boolean; hadBom: boolean } {
  let bytes: Uint8Array = buf;
  let hadBom = false;
  if (charset === "utf-8" && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bytes = buf.subarray(3);
    hadBom = true;
  }
  const text = new TextDecoder(charset, { fatal: false }).decode(bytes);
  // Support CRLF, LF, and classic-Mac CR-only (Reunion) line endings.
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") && !text.includes("\n") ? "\r" : "\n";
  const finalNewline = /[\r\n]$/.test(text);
  return { text, eol, finalNewline, hadBom };
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

interface Line {
  level: number;
  xref?: string; // xref this line DEFINES (level-0 records)
  tag: string;
  value?: string;
  raw: string; // original text, used only for size estimation
}

const LINE_RE = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/;

function parseLine(raw: string): Line | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  return { level: Number(m[1]), xref: m[2], tag: m[3], value: m[4], raw };
}

interface Record {
  tag: string;
  xref?: string;
  lines: Line[];
}

function groupRecords(lines: Line[]): Record[] {
  const recs: Record[] = [];
  let cur: Record | null = null;
  for (const ln of lines) {
    if (ln.level === 0) {
      cur = { tag: ln.tag, xref: ln.xref, lines: [ln] };
      recs.push(cur);
    } else if (cur) {
      cur.lines.push(ln);
    }
  }
  return recs;
}

const POINTER_RE = /@[^@]+@/g;
function pointersIn(rec: Record): string[] {
  const out: string[] = [];
  for (const ln of rec.lines) {
    if (!ln.value) continue;
    const m = ln.value.match(POINTER_RE);
    if (m) out.push(...m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

interface Pseudo {
  given: (s: string) => string;
  surname: (s: string) => string;
}

/** Assign from a fixed pool, appending a numeric suffix only once exhausted. */
function makeMapper(pool: readonly string[]): (key: string) => string {
  const seen = new Map<string, string>();
  return (key) => {
    const k = key.trim();
    if (!k) return key;
    const lk = k.toLowerCase();
    let v = seen.get(lk);
    if (!v) {
      const n = seen.size;
      v = n < pool.length ? pool[n] : `${pool[n % pool.length]}${Math.floor(n / pool.length) + 1}`;
      seen.set(lk, v);
      surnameTotal += pool === GIVEN_NAMES ? 0 : 1;
    }
    return v;
  };
}

// Given names use one global map (cross-file collisions are harmless — the
// surname gate rejects such pairs first).
const mapGiven = makeMapper(GIVEN_NAMES);
let stemCursor = 0;
let surnameTotal = 0;

/**
 * Build a per-file pseudonymizer. Each file gets a *contiguous block of whole
 * surname stems* so its same-stem look-alikes never leak into another file.
 */
function makeFilePseudonyms(distinctSurnames: number): Pseudo {
  const stems = Math.ceil(distinctSurnames / STEM_SIZE) + 1; // +1 stem of slack
  const block = SURNAMES.slice(stemCursor * STEM_SIZE, (stemCursor + stems) * STEM_SIZE);
  stemCursor += stems;
  if (!block.length) throw new Error("surname stem pool exhausted — add more stems");
  return { given: mapGiven, surname: makeMapper(block) };
}

const SURNAME_VALUE_TAGS = new Set(["SURN", "_MARNM", "SPFX"]);

/** Count distinct real surnames in a slice, matching what `anonymizeRecord` maps. */
function countDistinctSurnames(records: Record[]): number {
  const seen = new Set<string>();
  for (const rec of records) {
    for (const ln of rec.lines) {
      if (!ln.value) continue;
      if (ln.tag === "NAME") {
        const s = /^[^/]*\/([^/]*)\//.exec(ln.value)?.[1]?.trim();
        if (s) seen.add(s.toLowerCase());
      } else if (SURNAME_VALUE_TAGS.has(ln.tag)) {
        seen.add(ln.value.trim().toLowerCase());
      }
    }
  }
  return seen.size;
}

/** Rewrite a `given /surname/ suffix` NAME value with consistent pseudonyms. */
function anonName(value: string, ps: Pseudo): string {
  const m = /^([^/]*)(?:\/([^/]*)\/)?(.*)$/.exec(value);
  if (!m) return value;
  const givenPart = m[1] ?? "";
  const surnamePart = m[2];
  const suffix = m[3] ?? "";
  const given = givenPart
    .split(/(\s+)/)
    .map((tok) => (/\S/.test(tok) ? ps.given(tok) : tok))
    .join("");
  let out = given;
  if (surnamePart !== undefined) out += `/${surnamePart.trim() ? ps.surname(surnamePart) : ""}/`;
  out += suffix;
  return out;
}

const GIVEN_TAGS = new Set(["GIVN", "NICK", "_AKA", "RUFNAME", "_RUFNAME"]);
const SURNAME_TAGS = new Set(["SURN", "_MARNM", "SPFX"]);
const NOTEISH_TAGS = new Set(["NOTE", "TEXT"]);
const CONTACT_TAGS = new Set(["EMAIL", "_EMAIL", "PHON", "FAX", "MOBILE", "_PHON"]);
const ADDR_TAGS = new Set(["ADDR", "ADR1", "ADR2", "ADR3", "CITY", "STAE", "POST", "CTRY", "_ADDR"]);
const SUBMITTER_RECORD_TAGS = new Set(["SUBM", "SUBN", "HEAD"]);

let contactSeq = 0;
let fileSeq = 0;

function anonymizeRecord(rec: Record, ps: Pseudo): void {
  const inSubmitterCtx = SUBMITTER_RECORD_TAGS.has(rec.tag);
  // Track NOTE/TEXT scrub context by the level a note opened at.
  let noteLevel = -1;
  for (const ln of rec.lines) {
    if (noteLevel >= 0 && ln.level <= noteLevel) noteLevel = -1;

    // NOTE/TEXT with inline text (not a pointer) → scrub, and follow CONC/CONT.
    if (NOTEISH_TAGS.has(ln.tag)) {
      if (ln.value && !/^@[^@]+@$/.test(ln.value)) {
        ln.value = "Lorem ipsum note.";
        noteLevel = ln.level;
      }
      continue;
    }
    if (noteLevel >= 0 && (ln.tag === "CONC" || ln.tag === "CONT")) {
      ln.value = ln.value ? "lorem ipsum" : ln.value;
      continue;
    }

    if (ln.tag === "NAME" && ln.value) {
      ln.value = anonName(ln.value, ps);
      continue;
    }
    if (ln.value && GIVEN_TAGS.has(ln.tag)) {
      ln.value = ps.given(ln.value);
      continue;
    }
    if (ln.value && SURNAME_TAGS.has(ln.tag)) {
      ln.value = ps.surname(ln.value);
      continue;
    }
    if (ln.value && CONTACT_TAGS.has(ln.tag)) {
      ln.value = ln.tag === "PHON" || ln.tag === "FAX" || ln.tag === "MOBILE" || ln.tag === "_PHON"
        ? "+000 000 000"
        : `user${++contactSeq}@example.test`;
      continue;
    }
    // Media file paths often embed a local user directory → scrub, keep extension.
    if (ln.tag === "FILE" && ln.value) {
      const ext = /\.([A-Za-z0-9]{1,5})$/.exec(ln.value)?.[1] ?? "jpg";
      ln.value = `media/file${++fileSeq}.${ext}`;
      continue;
    }
    // Submitter postal address is the file owner → scrub only in submitter ctx.
    if (inSubmitterCtx && ln.value && ADDR_TAGS.has(ln.tag)) {
      ln.value = ln.tag === "ADDR" || ln.tag === "ADR1" ? "Naslov 1" : ln.tag === "POST" ? "0000" : "—";
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Slice + assemble
// ---------------------------------------------------------------------------

interface FixtureMeta {
  file: string;
  exporter: string;
  version: string;
  charset: Charset;
  eol: "LF" | "CRLF" | "CR";
  finalNewline: boolean;
  bom: boolean;
  bytes: number;
  records: { INDI: number; FAM: number; other: number };
  note?: string;
}

function buildFixture(spec: Spec): FixtureMeta {
  const buf = readFileSync(resolve(SRC_DIR, spec.src));
  const { text, eol, finalNewline, hadBom } = decode(buf, spec.charset);
  const rawLines = text.split(/\r\n|\r|\n/);
  // split() on the final newline yields a trailing "" — drop it; we re-add EOLs.
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();

  const lines: Line[] = [];
  for (const raw of rawLines) {
    const ln = parseLine(raw);
    if (ln) lines.push(ln);
  }
  const records = groupRecords(lines);

  const head = records.find((r) => r.tag === "HEAD");
  const trlr = records.find((r) => r.tag === "TRLR");
  const byXref = new Map<string, Record>();
  for (const r of records) if (r.xref) byXref.set(r.xref, r);

  // 1. Keep INDI records up to the byte budget (min 12).
  const budget = spec.indiBudget ?? INDI_BUDGET_DEFAULT;
  const keptIndi: Record[] = [];
  let acc = 0;
  for (const r of records) {
    if (r.tag !== "INDI") continue;
    const size = r.lines.reduce((n, l) => n + l.raw.length + 1, 0);
    if (keptIndi.length >= 12 && acc + size > budget) break;
    keptIndi.push(r);
    acc += size;
  }

  // 2. One hop: records referenced by kept INDIs. Keep a few of each type so
  //    citation/media *shape* is represented without dragging in hundreds of
  //    SOUR/OBJE records — that's what blows past the size budget.
  const REF_CAP: Record<string, number> = { FAM: 400, SOUR: 15, OBJE: 12, NOTE: 10, REPO: 4, SUBM: 1 };
  const refCount: Record<string, number> = {};
  const keptXrefs = new Set<string>();
  for (const r of keptIndi) if (r.xref) keptXrefs.add(r.xref);
  const referenced: Record[] = [];
  const tryKeep = (ptr: string, allowed: Set<string>): void => {
    if (keptXrefs.has(ptr)) return;
    const target = byXref.get(ptr);
    if (!target || !allowed.has(target.tag)) return;
    const cap = REF_CAP[target.tag] ?? 0;
    if ((refCount[target.tag] ?? 0) >= cap) return;
    refCount[target.tag] = (refCount[target.tag] ?? 0) + 1;
    keptXrefs.add(ptr);
    referenced.push(target);
  };
  const HOP1 = new Set(["FAM", "SOUR", "OBJE", "NOTE", "REPO", "SUBM"]);
  for (const r of keptIndi) for (const ptr of pointersIn(r)) tryKeep(ptr, HOP1);
  // 2b. Second hop from kept SOUR/FAM → their REPO/OBJE/NOTE (citation shape).
  const HOP2 = new Set(["REPO", "OBJE", "NOTE", "SOUR"]);
  for (const r of [...referenced]) {
    if (r.tag !== "SOUR" && r.tag !== "FAM") continue;
    for (const ptr of pointersIn(r)) tryKeep(ptr, HOP2);
  }

  // Keep the submitter record referenced by HEAD, too.
  if (head) {
    for (const ptr of pointersIn(head)) {
      const t = byXref.get(ptr);
      if (t && !keptXrefs.has(ptr)) {
        keptXrefs.add(ptr);
        referenced.push(t);
      }
    }
  }

  const kept: Record[] = [];
  if (head) kept.push(head);
  kept.push(...keptIndi, ...referenced);
  if (trlr) kept.push(trlr);

  // 3. Prune dangling pointer lines (and their subtrees) to records we dropped.
  for (const rec of kept) {
    const pruned: Line[] = [];
    let dropUntil = -1;
    for (const ln of rec.lines) {
      if (dropUntil >= 0) {
        if (ln.level > dropUntil) continue; // still inside the dropped subtree
        dropUntil = -1;
      }
      if (ln.level > 0 && ln.value && /^@[^@]+@$/.test(ln.value) && !keptXrefs.has(ln.value)) {
        dropUntil = ln.level; // drop this line + deeper children
        continue;
      }
      pruned.push(ln);
    }
    rec.lines = pruned;
  }

  // 4. Anonymize. Allocate this file a contiguous surname-stem block so its
  //    look-alike surnames can't collide with any other file's.
  const ps = makeFilePseudonyms(countDistinctSurnames(kept));
  for (const rec of kept) anonymizeRecord(rec, ps);

  // 5. Reassemble → text → original charset bytes.
  const outLines: string[] = [];
  for (const rec of kept) for (const ln of rec.lines) outLines.push(renderLine(ln));
  let outText = outLines.join(eol);
  if (finalNewline) outText += eol;
  const bom = spec.charset === "utf-8" && hadBom ? Uint8Array.of(0xef, 0xbb, 0xbf) : new Uint8Array(0);
  const body = buildEncoder(spec.charset)(outText);
  const bytes = new Uint8Array(bom.length + body.length);
  bytes.set(bom, 0);
  bytes.set(body, bom.length);
  writeFileSync(resolve(OUT_DIR, spec.out), bytes);

  const counts = { INDI: 0, FAM: 0, other: 0 };
  for (const r of kept) {
    if (r.tag === "INDI") counts.INDI++;
    else if (r.tag === "FAM") counts.FAM++;
    else if (r.tag !== "HEAD" && r.tag !== "TRLR") counts.other++;
  }
  return {
    file: spec.out,
    exporter: spec.exporter,
    version: spec.version,
    charset: spec.charset,
    eol: eol === "\r\n" ? "CRLF" : eol === "\r" ? "CR" : "LF",
    finalNewline,
    bom: bom.length > 0,
    bytes: bytes.length,
    records: counts,
    note: spec.note,
  };
}

/** Render a Line back to its exact GEDCOM textual form. */
function renderLine(ln: Line): string {
  let s = String(ln.level);
  if (ln.xref) s += ` ${ln.xref}`;
  s += ` ${ln.tag}`;
  if (ln.value !== undefined) s += ` ${ln.value}`;
  return s;
}

// ---------------------------------------------------------------------------

function main() {
  const manifest: FixtureMeta[] = [];
  for (const spec of SPECS) {
    contactSeq = 0;
    fileSeq = 0;
    try {
      const meta = buildFixture(spec);
      manifest.push(meta);
      console.log(
        `✓ ${meta.file.padEnd(34)} ${String(Math.round(meta.bytes / 1024) + "KB").padStart(6)}  ` +
          `INDI:${meta.records.INDI} FAM:${meta.records.FAM} other:${meta.records.other}  ${meta.charset}/${meta.eol}`,
      );
    } catch (err) {
      console.error(`✗ ${spec.out}: ${(err as Error).message}`);
    }
  }
  writeFileSync(
    resolve(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`\nWrote ${manifest.length} fixtures + manifest.json → src/__fixtures__/corpus/`);
  console.log(`Surname stems used: ${stemCursor}/${SURNAMES.length / STEM_SIZE} (${surnameTotal} distinct surnames mapped).`);
}

main();
