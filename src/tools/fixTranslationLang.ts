import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { type RecordPatch } from "../ui/historyTypes";
import { nodeAtPath, validateConformance } from "./conformance/conformance";
import { recordPatch } from "./fixConformance";
import { applyPassSafely } from "./passSafety";

/**
 * GEDCOM 7 translations written without the language the standard requires:
 *
 *     2 PLAC Srednje Bitnje,Kranj
 *     3 TRAN M.Feichting          ← 7.0 wants `4 LANG de` beneath it
 *
 * MacFamilyTree writes a place's historical names this way, often several in
 * one line (`M.Vellach, Media Wella` — German and Latin). The findings are the
 * conformance check's own ("… TRAN has no LANG line"), grouped here by value so
 * a choice made once settles every line with that name. A place translation is
 * split at its commas into parts, each with a language of its own: parts that
 * share a language stay together in one line, and each further language gets a
 * `TRAN` line of its own beside the first. A name's translation is one part.
 *
 * `und` is BCP 47's "undetermined" — the code that makes the line standard
 * without claiming a language.
 */

export const UNDETERMINED = "und";

export interface UntaggedTranslation {
  /** Identity of the group: the kind of line and its value. */
  key: string;
  value: string;
  /** A place's translation (split at commas), as opposed to a name's. */
  place: boolean;
  /** How many lines carry this value. */
  count: number;
  parts: string[];
  /** The language suggested for each part. */
  suggested: string[];
}

/** One untagged `TRAN` line: where it is, and its group. */
interface Hit {
  recordId: string;
  path: string;
  key: string;
}

function keyOf(place: boolean, value: string): string {
  return `${place ? "P" : "N"}\0${value}`;
}

function partsOf(place: boolean, value: string): string[] {
  if (!place) return [value];
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [value];
}

function hits(dataset: Pick<Dataset, "records">): (Hit & { value: string; place: boolean })[] {
  const byXref = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref) byXref.set(r.xref, r);
  const out: (Hit & { value: string; place: boolean })[] = [];
  for (const issue of validateConformance(dataset)) {
    if (issue.messageKey !== "tools.validate.struct.issue.missing" || issue.sample !== "LANG") continue;
    const parent = String(issue.messageVars.parent ?? "");
    if (!parent.endsWith(".TRAN") || !issue.recordId || issue.path === undefined) continue;
    const rec = byXref.get(issue.recordId);
    const node = rec && nodeAtPath(rec, issue.path);
    const value = node?.value?.trim();
    if (!value) continue;
    const place = parent.endsWith(".PLAC.TRAN");
    out.push({ recordId: issue.recordId, path: issue.path, key: keyOf(place, value), value, place });
  }
  return out;
}

// What a historical place name's language looks like, by its spelling. Only a
// first guess for the picker: a name with no mark of its own takes the
// language most of the file's marked names have.
const SL_RE = /[čšžČŠŽ]|^Sv\.\s|\s(?:na|pri|pod|nad|ob)\s/;
const LA_WORDS = new Set([
  "media", "medium", "inferior", "inferiori", "inferioris", "superior", "superiori", "superioris",
  "sanctus", "sancti", "sancta", "sanctae", "sanctum", "villa", "mons", "montis", "vallis",
  "castrum", "nova", "novum", "vetus", "parva", "magna", "alta",
]);
const LA_RE = /(?:ensis|um)$/i;
const DE_RE = /[äöüÄÖÜß]|sch|^(?:Ober|Unter|Mitter|Groß|Gross|Klein|Alt|Neu|Windisch|Deutsch|Sankt)|^St\.\s|^[MOU]\.\s?\S|(?:dorf|berg|burg|feld|hof|heim|thal|bach|ach|itz|stein|kirch|kirchen|haus|hausen|ingen|ing|wert|werth|brunn|ein)$/i;

/** The language a part's spelling suggests, or undefined when it has no mark. */
export function suggestLanguage(part: string): string | undefined {
  if (SL_RE.test(part)) return "sl";
  const words = part.toLowerCase().split(/[\s.]+/).filter(Boolean);
  if (words.some((w) => LA_WORDS.has(w)) || LA_RE.test(part)) return "la";
  if (DE_RE.test(part)) return "de";
  return undefined;
}

/** Every untagged translation in the file, one entry per value, most lines first. */
export function untaggedTranslations(dataset: Pick<Dataset, "records">): UntaggedTranslation[] {
  const groups = new Map<string, { value: string; place: boolean; count: number }>();
  for (const h of hits(dataset)) {
    const g = groups.get(h.key);
    if (g) g.count++;
    else groups.set(h.key, { value: h.value, place: h.place, count: 1 });
  }
  const entries = [...groups].map(([key, g]) => {
    const parts = partsOf(g.place, g.value);
    return { key, ...g, parts, guesses: parts.map(suggestLanguage) };
  });
  // The file's own habit, weighted by lines: what an unmarked part falls back to.
  const votes = new Map<string, number>();
  for (const e of entries) {
    for (const lang of e.guesses) if (lang) votes.set(lang, (votes.get(lang) ?? 0) + e.count);
  }
  const fallback = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? UNDETERMINED;
  return entries
    .map(({ guesses, ...e }) => ({ ...e, suggested: guesses.map((g) => g ?? fallback) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function langLine(level: number, lang: string): GedNode {
  return { level, tag: "LANG", value: lang, children: [] };
}

/** Give one `TRAN` line its language(s): a `LANG` beneath it, or — when its
 *  parts differ — one line per language, the first keeping the original. */
function tagLine(parent: GedNode, node: GedNode, parts: string[], langs: string[]): void {
  const buckets = new Map<string, string[]>();
  parts.forEach((part, i) => {
    const lang = langs[i] || UNDETERMINED;
    const list = buckets.get(lang);
    if (list) list.push(part);
    else buckets.set(lang, [part]);
  });
  const [[firstLang, firstParts], ...rest] = [...buckets];
  if (rest.length) node.value = firstParts.join(", ");
  node.children.push(langLine(node.level + 1, firstLang));
  const extra = rest.map(([lang, list]): GedNode => ({
    level: node.level, tag: "TRAN", value: list.join(", "), children: [langLine(node.level + 1, lang)],
  }));
  parent.children.splice(parent.children.indexOf(node) + 1, 0, ...extra);
}

/**
 * Write the chosen languages: `choices` maps a group's key to one language per
 * part. Groups left out are left alone. Mutates the dataset in place and
 * returns `RecordPatch[]` for the undo stack.
 */
export function tagTranslations(dataset: Dataset, choices: Map<string, string[]>): RecordPatch[] {
  const byRecord = new Map<string, Hit[]>();
  for (const h of hits(dataset)) {
    if (!choices.has(h.key)) continue;
    const list = byRecord.get(h.recordId);
    if (list) list.push(h);
    else byRecord.set(h.recordId, [h]);
  }
  if (!byRecord.size) return [];

  const records = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref && byRecord.has(r.xref)) records.set(r.xref, r);

  const patches: RecordPatch[] = [];
  applyPassSafely(dataset, (journal) => {
    for (const [xref, list] of byRecord) {
      const rec = records.get(xref);
      if (!rec) continue;
      const before = cloneNode(rec);
      journal.keep(xref, before);
      // Every line is found before any is split, so the paths stay valid.
      const targets = list.map((h) => {
        const parentPath = h.path.split(".").slice(0, -1).join(".");
        return { h, node: nodeAtPath(rec, h.path), parent: nodeAtPath(rec, parentPath) };
      });
      for (const { h, node, parent } of targets) {
        if (!node || !parent) continue;
        const value = node.value?.trim() ?? "";
        tagLine(parent, node, partsOf(h.key.startsWith("P"), value), choices.get(h.key)!);
      }
      patches.push(recordPatch(dataset, xref, rec, before));
    }
  });
  return patches;
}
