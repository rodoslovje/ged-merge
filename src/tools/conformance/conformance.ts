import type { Dataset, GedNode } from "../../gedcom/types";
import { firstChild, nodesEqual } from "../../gedcom/node";
import { fileFormOf } from "../../gedcom/mediaForm";
import { nameType70 } from "../../gedcom/name";
import { isVoidPointer } from "../../gedcom/uri";
import { vendorTagInfo } from "../../gedcom/vendorTags";
import { isUnparseable } from "../fixDates";
import type { SpecTable } from "./types";
import { compile, type Compiled } from "./compile";
import { SPEC_55, SPEC_551, SPEC_555 } from "./spec551";
import { SPEC_70 } from "./spec70";

/**
 * Standard conformance: the raw tree held against the structure table of the
 * GEDCOM version the file declares (HEAD.GEDC.VERS) — which tags may stand
 * under which line, how many times, what a pointer must point at, and which
 * values an enumerated line may take. The tables are data (./spec551.ts typed
 * from the 5.5.1 grammar, ./spec70.ts generated from the 7.0 spec's extract),
 * so this module only walks.
 *
 * What it leaves to the other checks, so nothing is reported twice:
 *  - vendor extensions (`_TAG`): allowed anywhere, never descended into;
 *  - a tag no table of this version knows (unknown or a vendor's bare tag):
 *    the structure check's unknown/custom-tag inventory;
 *  - a pointer to a record that does not exist: "Dangling references";
 *  - a person's FAMC/FAMS or a family's HUSB/WIFE/CHIL that reaches no
 *    family (or person) — wrong type included: "Broken links";
 *  - two different partners in one FAM's HUSB (or WIFE): "Two partners in
 *    one slot";
 *  - a date that does not parse at all: "Unparseable dates".
 *
 * Physical line length is not checked: the parser has folded CONT/CONC lines
 * into one value by the time the tree exists, so the file's own line breaks
 * are no longer known. Level jumps are the parser's own finding.
 */

export type ConformanceCategory =
  | "pointerType"
  | "cardinality"
  | "missingLine"
  | "misplacedTag"
  | "enumValue"
  | "valueFormat"
  | "xrefShape";

export interface ConformanceIssue {
  category: ConformanceCategory;
  severity: "error" | "warning";
  messageKey: string;
  messageVars: Record<string, string | number>;
  recordId?: string;
  recordTag?: string;
  sample?: string;
  tooltip?: string;
  /** Child-index path from the record to the line the finding is about ("3.1";
   *  "" is the record itself) — how the fix finds it again. */
  path?: string;
  /** The value the value fix would write — or, on a missing-line finding,
   *  the value of the line the fix would add (a media file's `FORM`). */
  fix?: string;
  /** The word the fix keeps as a `PHRASE` under its value (7.0's `OTHER`). */
  fixPhrase?: string;
  /** Set when every repeat is an exact copy of the first, so the repeats can
   *  go without losing anything. */
  repeat?: boolean;
  /** Set when `fix` is text the fix moves off the line into a NOTE beneath
   *  it (a 7.0 event line carrying more than Y). */
  toNote?: boolean;
  /** Set on the media records' `TITL`/`FORM`-beside-`FILE` habit, which the
   *  fix moves under `FILE` in every media record at once. */
  relocate?: boolean;
  /** Set on a source's own `AGNC`, which neither version allows on the record:
   *  the fix moves it to `DATA.AGNC` in every source at once. */
  agency?: boolean;
}

/** The table for the version the file's header declares, or undefined when it
 *  names none we hold (the version finding reports that). */
export function tableFor(records: GedNode[]): SpecTable | undefined {
  const head = records.find((r) => r.tag === "HEAD");
  const gedc = head && firstChild(head, "GEDC");
  const vers = (gedc && firstChild(gedc, "VERS")?.value?.trim()) ?? "";
  if (/^7\.\d/.test(vers)) return SPEC_70;
  if (vers === "5.5.5") return SPEC_555;
  if (vers === "5.5.1") return SPEC_551;
  if (vers === "5.5") return SPEC_55;
  return undefined;
}

// ── Value grammar ────────────────────────────────────────────────────────────

const POINTER_RE = /^@[^@#][^@]*@$/;
/** 5.5.x AGE: `< 12y 3m 2d`, `CHILD`, … Units in order, each optional. */
const AGE_551 = /^[<>]?\s*(?:CHILD|INFANT|STILLBORN|(?=\d)(?:\d+y)?\s*(?:\d+m)?\s*(?:\d+d)?)$/i;
/** 7.0 AGE: the same, plus weeks, minus the keywords. */
const AGE_70 = /^[<>]?\s*(?=\d)(?:\d+y)?\s*(?:\d+m)?\s*(?:\d+w)?\s*(?:\d+d)?$/i;
/** BCP 47, by shape: a 2–8 letter language subtag and any 1–8 character subtags. */
const BCP47 = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/** The 5.5.1 calendar escapes 7.0 writes as a word (it has no ROMAN or UNKNOWN). */
const CALENDARS_70: Record<string, string> = {
  GREGORIAN: "GREGORIAN", JULIAN: "JULIAN", HEBREW: "HEBREW", "FRENCH R": "FRENCH_R",
};

/** Check one value against an enumeration: undefined when it is in the set,
 *  else the set value it differs from only in case (the fix), or "" for none. */
function enumVerdict(value: string, set: string[], is70: boolean): string | undefined {
  if (set.includes(value)) return undefined;
  if (is70 && value.startsWith("_")) return undefined; // an extension value
  if (set.includes("()") && /^\(.*\)$/.test(value)) return undefined;
  const lower = value.toLowerCase();
  return set.find((s) => s !== "()" && s.toLowerCase() === lower) ?? "";
}

function lineOf(node: GedNode): string {
  const xref = node.xref ? ` ${node.xref}` : "";
  const value = node.value != null ? ` ${node.value.replace(/\n/g, " ⏎ ")}` : "";
  return `${node.level}${xref} ${node.tag}${value}`;
}

function truncate(s: string, n = 60): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ── The walk ─────────────────────────────────────────────────────────────────

interface Ctx {
  spec: Compiled;
  /** xref → record tag, for pointer targets. */
  recordTags: Map<string, string>;
  emit: (issue: ConformanceIssue) => void;
  /** Misplaced tags, tallied per tag and parent so a habit is one row. */
  misplaced: Map<string, { count: number; issue: ConformanceIssue }>;
}

function checkRecord(rec: GedNode, ctx: Ctx): void {
  const { spec } = ctx;
  if (rec.tag.startsWith("_") || !rec.tag) return;
  const recordId = rec.xref;
  const recordTag = rec.tag;
  const base = { recordId, recordTag };
  const id = spec.roots[rec.tag];
  if (!id) {
    if (spec.universe.has(rec.tag)) tallyMisplaced(ctx, rec, "", "misplacedRoot", base, "");
    return;
  }

  if (rec.xref) checkXref(rec.xref, ctx, base);

  // Where the walk stands, kept as two stacks and turned into strings only
  // for a finding: the child indices ("3.1", the fix's path) and the tags
  // ("INDI.BIRT", the finding's wording).
  const indices: number[] = [];
  const tags: string[] = [rec.tag];
  const loc: Loc = { path: () => indices.join("."), where: () => tags.join(".") };

  const walk = (node: GedNode, structId: string): void => {
    const struct = spec.structs.get(structId);
    if (!struct) return;
    checkPayload(node, struct.payload, loc, ctx, base);
    if (!node.children.length && !struct.required.length) return;

    let seen: Map<string, GedNode[]> | undefined;
    node.children.forEach((child, i) => {
      const tag = child.tag;
      if (!tag || tag.startsWith("_")) return;
      const childSpec = struct.children.get(tag);
      if (!childSpec) {
        if (spec.universe.has(tag) && !vendorTagInfo(tag)) {
          indices.push(i);
          tallyMisplaced(ctx, child, loc.where(), "misplaced", base, loc.path());
          indices.pop();
        }
        return;
      }
      seen ??= new Map();
      const list = seen.get(tag);
      if (list) list.push(child);
      else seen.set(tag, [child]);
      indices.push(i);
      tags.push(tag);
      walk(child, childSpec.id);
      indices.pop();
      tags.pop();
    });

    for (const [tag, lines] of seen ?? []) {
      const childSpec = struct.children.get(tag)!;
      if (lines.length <= childSpec.max) continue;
      // Two different partners in one FAM slot are "Two partners in one
      // slot" — a question of who, not of how many lines.
      if (structId === spec.roots.FAM && (tag === "HUSB" || tag === "WIFE")) {
        if (new Set(lines.map((l) => l.value?.trim())).size > 1) continue;
      }
      const repeat = !!recordId && lines.slice(1).every((l) => nodesEqual(l, lines[0]));
      ctx.emit({
        ...base, category: "cardinality", severity: "warning",
        messageKey: "tools.validate.struct.issue.tooMany",
        messageVars: { tag, parent: loc.where(), count: lines.length, max: childSpec.max },
        sample: tag, tooltip: lines.map(lineOf).join("\n"), path: loc.path(), repeat: repeat || undefined,
      });
    }
    for (const [tag] of struct.required) {
      if (seen?.has(tag)) continue;
      // A media file's missing FORM is read off its name (`.jpg`, a web
      // address) — the one missing line the fix can add without guessing.
      const add = recordId && tag === "FORM" && node.tag === "FILE" && node.value
        ? fileFormOf(node.value, spec.is70)
        : undefined;
      ctx.emit({
        ...base, category: "missingLine", severity: "warning",
        messageKey: "tools.validate.struct.issue.missing",
        messageVars: { tag, parent: loc.where() },
        sample: tag, tooltip: add ? `${lineOf(node)} → ${tag} ${add}` : lineOf(node), path: loc.path(),
        fix: add,
      });
    }
  };
  walk(rec, id);
}

/** Where a line stands in its record, rendered on demand. */
interface Loc {
  path(): string;
  where(): string;
}

function tallyMisplaced(
  ctx: Ctx, node: GedNode, parent: string, key: "misplaced" | "misplacedRoot",
  base: { recordId?: string; recordTag?: string }, path: string,
): void {
  const k = `${node.tag}\0${parent}`;
  const seen = ctx.misplaced.get(k);
  if (seen) {
    seen.count++;
    return;
  }
  ctx.misplaced.set(k, {
    count: 1,
    issue: {
      ...base, category: "misplacedTag", severity: "warning",
      messageKey: `tools.validate.struct.issue.${key}`,
      messageVars: { tag: node.tag, parent, version: ctx.spec.version },
      sample: node.tag, tooltip: lineOf(node), path,
      // A media record's title and format beside its FILE (the 5.5 shape)
      // belong under it — a move the fix makes across the whole file.
      relocate: (parent === "OBJE" && (node.tag === "TITL" || node.tag === "FORM")) || undefined,
      // A source's own agency belongs under its DATA — the same move file-wide.
      agency: (parent === "SOUR" && node.tag === "AGNC") || undefined,
    },
  });
}

function checkXref(xref: string, ctx: Ctx, base: { recordId?: string; recordTag?: string }): void {
  const flag = (messageKey: string) =>
    ctx.emit({
      ...base, category: "xrefShape", severity: "warning",
      messageKey: `tools.validate.struct.issue.${messageKey}`,
      messageVars: { xref, version: ctx.spec.version }, sample: xref, tooltip: xref,
    });
  if (ctx.spec.is70) {
    if (!/^@[A-Z0-9_]+@$/.test(xref)) flag("xrefChars");
  } else if (xref.length > 22) {
    flag("xrefLong");
  } else if (!/^@[A-Za-z0-9]/.test(xref)) {
    flag("xrefStart");
  }
}

function checkPayload(
  node: GedNode, payload: string, loc: Loc, ctx: Ctx,
  base: { recordId?: string; recordTag?: string },
): void {
  const { spec } = ctx;
  // Most lines are text: nothing to hold them to unless they look like a pointer.
  if ((payload === "T" || payload === "") && !node.value?.includes("@")) return;
  const value = node.value?.trim() ?? "";
  const tag = node.tag;
  const fixable = !!base.recordId;
  const emit = (
    category: ConformanceCategory, messageKey: string, vars: Record<string, string | number>, fix?: string,
    { toNote, fixPhrase }: { toNote?: boolean; fixPhrase?: string } = {},
  ) =>
    ctx.emit({
      ...base, category, severity: category === "pointerType" ? "error" : "warning",
      messageKey: `tools.validate.struct.issue.${messageKey}`,
      messageVars: { tag, sample: truncate(value), parent: loc.where(), version: spec.version, ...vars },
      sample: truncate(value), path: loc.path(),
      tooltip: fix
        ? `${lineOf(node)} → ${toNote ? `${node.level + 1} NOTE ${fix}` : fix}${fixPhrase ? ` + PHRASE ${fixPhrase}` : ""}`
        : lineOf(node),
      fix: fixable ? fix : undefined,
      toNote: fixable && toNote ? true : undefined,
      fixPhrase: fixable ? fixPhrase : undefined,
    });

  if (payload.startsWith("@")) {
    const expected = payload.slice(1).replace("?", "");
    if (isVoidPointer(value)) {
      if (!spec.is70) emit("pointerType", "voidPointer", {});
      return;
    }
    if (POINTER_RE.test(value)) {
      const actual = ctx.recordTags.get(value);
      if (!actual) return; // dangling — reported as such
      // A person's FAMC/FAMS and a family's HUSB/WIFE/CHIL are "Broken links"
      // whenever they do not reach a family (or a person): that check reports
      // them, and its fix removes them.
      const where = loc.where();
      if (where === "INDI.FAMC" || where === "INDI.FAMS") return;
      if (where === "FAM.HUSB" || where === "FAM.WIFE" || where === "FAM.CHIL") return;
      // 5.5's association names the kind of record it points at itself.
      const want = tag === "ASSO" && !spec.is70 ? (firstChild(node, "TYPE")?.value?.trim().toUpperCase() || expected) : expected;
      if (actual !== want) emit("pointerType", "pointerType", { xref: value, actual, expected: want });
    } else if (value && !payload.endsWith("?")) {
      emit("pointerType", "pointerExpected", { expected });
    }
    return;
  }
  // A pointer where the standard wants text (7.0's NOTE @N1@ — that is SNOTE).
  if (POINTER_RE.test(value) && ctx.recordTags.has(value)) {
    emit("pointerType", "pointerUnexpected", { xref: value });
    return;
  }
  if (!value) return;

  if (payload === "Y") {
    // A lower-case y is the Y. Any other text is something said about the
    // event (a doubtful date or place, an address): the fix keeps it word for
    // word in a NOTE on the event.
    if (value === "y") emit("enumValue", "badY", {}, "Y");
    else if (value !== "Y") emit("enumValue", "badY", {}, value, { toNote: true });
  } else if (payload.startsWith("E:") || payload.startsWith("L:")) {
    const set = spec.enums.get(payload.slice(2));
    if (!set) return;
    // Any name type has a home in 7.0's: the value it plainly means, or OTHER
    // with the word kept as its PHRASE — so the fix loses nothing.
    if (spec.is70 && payload === "E:enumset-NAME-TYPE" && enumVerdict(value, set, true) === "") {
      const mapped = nameType70(value);
      const key = mapped.phrase ? "nameTypeOther" : "nameTypeNearest";
      emit("enumValue", key, { standard: mapped.type }, mapped.type, { fixPhrase: mapped.phrase });
      return;
    }
    const items = payload.startsWith("L:") ? value.split(",").map((s) => s.trim()) : [value];
    const verdicts = items.map((v) => enumVerdict(v, set, spec.is70));
    if (verdicts.every((v) => v === undefined)) return;
    // MyHeritage writes QUAY 4 (and up) for its best evidence: the standard's
    // best is 3, so the fix lowers it there.
    if (tag === "QUAY" && /^\d+$/.test(value) && Number(value) > 3) {
      emit("enumValue", "quayAbove", {}, "3");
      return;
    }
    const fix = verdicts.every((v) => v !== "")
      ? items.map((v, i) => verdicts[i] ?? v).join(", ")
      : undefined;
    const allowed = set.filter((s) => s !== "()").join(", ");
    emit("enumValue", fix ? "enumCase" : "enumValue", fix ? { allowed, standard: fix } : { allowed }, fix);
  } else if (payload === "D") {
    checkCalendar(value, spec.is70, emit);
  } else if (payload === "A") {
    if (!(spec.is70 ? AGE_70 : AGE_551).test(value)) emit("valueFormat", "badAge", {});
  } else if (payload === "G") {
    if (!BCP47.test(value)) emit("valueFormat", "badLang", {});
  }
}

/**
 * A 7.0 date still carrying a 5.5.1 calendar escape (`@#DJULIAN@ 1700`): 7.0
 * writes the calendar as a word in the same place (`JULIAN 1700`, `ABT JULIAN
 * 1700`). In 5.5.x the escape is the grammar, and an escape naming no calendar
 * leaves the date unreadable — "Unparseable dates" reports that one.
 */
function checkCalendar(
  value: string, is70: boolean,
  emit: (category: ConformanceCategory, key: string, vars: Record<string, string | number>, fix?: string) => void,
): void {
  if (!is70 || !value.includes("@#") || isUnparseable(value)) return;
  const fix = value
    .replace(/@#D([^@]+)@\s*/g, (m, name: string) => CALENDARS_70[name] ? `${CALENDARS_70[name]} ` : m)
    .trim();
  // Only where the word lands where 7.0 wants it: before the date, after any
  // qualifier — "@#DJULIAN@ ABT 1700" has no 7.0 spelling in that order.
  const sound = !fix.includes("@#") && !/\b(?:GREGORIAN|JULIAN|HEBREW|FRENCH_R)\s+(?:ABT|CAL|EST|BEF|AFT|FROM|TO|BET|AND|INT)\b/.test(fix);
  emit("enumValue", "calendarEscape", {}, sound ? fix : undefined);
}

// ── Entry points ─────────────────────────────────────────────────────────────

function scan(records: GedNode[], table: SpecTable, only?: string): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const recordTags = new Map<string, string>();
  for (const r of records) if (r.xref) recordTags.set(r.xref, r.tag);
  const ctx: Ctx = { spec: compile(table), recordTags, emit: (i) => issues.push(i), misplaced: new Map() };
  for (const rec of records) {
    if (only !== undefined && rec.xref !== only) continue;
    checkRecord(rec, ctx);
  }
  for (const { count, issue } of ctx.misplaced.values()) {
    issue.messageVars.count = count;
    issues.push(issue);
  }
  return issues;
}

/** Every conformance finding in the file, against the table of the version it
 *  declares; none when it declares none we hold. */
export function validateConformance(ds: Pick<Dataset, "records">): ConformanceIssue[] {
  const table = tableFor(ds.records);
  return table ? scan(ds.records, table) : [];
}

/** The findings a fix can settle: a value written in the wrong case, a line
 *  repeated as an exact copy, a media file's missing FORM, text on an event
 *  line that belongs in its NOTE, media lines kept beside their FILE, or a
 *  source's agency on the record instead of under its DATA. */
export function isFixable(issue: ConformanceIssue): boolean {
  return !!issue.recordId && (issue.fix !== undefined || !!issue.repeat || !!issue.relocate || !!issue.agency);
}

/** The findings in `records` that the fix would settle — for one record only
 *  when `only` names it. */
export function fixableConformance(records: GedNode[], only?: string): ConformanceIssue[] {
  const table = tableFor(records);
  if (!table) return [];
  return scan(records, table, only).filter(isFixable);
}

/** The line a path names inside a record. */
export function nodeAtPath(rec: GedNode, path: string): GedNode | undefined {
  let node: GedNode | undefined = rec;
  for (const i of path ? path.split(".") : []) node = node?.children[Number(i)];
  return node;
}
