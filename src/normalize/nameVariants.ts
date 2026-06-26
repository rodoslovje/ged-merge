import type { Dataset, GedNode } from "../gedcom/types";
import type { NameLayout, NameProfile, NameVariantKind, NameVariantTarget, NormChange } from "./types";
import { walkNodes } from "./walk";

/** Where a variant's name text lives: the surname slot or the given slot. */
type Slot = "surname" | "given";

interface VariantSpec {
  /** Lowercased `2 TYPE` tokens that denote this variant on a separate NAME record. */
  types: string[];
  /** Inline sub-tags (on the primary NAME) that denote it; the first is canonical. */
  tags: string[];
  /** Which name component the inline tag carries. */
  slot: Slot;
}

/**
 * The variants we reshape and the tags/types that denote each. Custom tags whose
 * meaning is ambiguous (`_FORMERNAME` is a former *given* name; `_RNAME`/
 * `_RUFNAME` a call name; `_OTHN` "other") are deliberately left out — they are
 * passed through untouched rather than risk mangling them.
 */
const VARIANTS: Record<NameVariantKind, VariantSpec> = {
  married: { types: ["married"], tags: ["_MARNM"], slot: "surname" },
  birth: { types: ["birth", "maiden"], tags: ["_BIRN"], slot: "surname" },
  aka: { types: ["aka"], tags: ["_AKA", "_AKAN"], slot: "given" },
  nick: { types: ["nick"], tags: ["NICK"], slot: "given" },
};

const KINDS = Object.keys(VARIANTS) as NameVariantKind[];

/** Sub-tag order within a NAME node; the variant tags sit with the name parts. */
const NAME_CHILD_ORDER = ["NPFX", "GIVN", "NICK", "SPFX", "SURN", "_MARNM", "_BIRN", "_AKA", "_AKAN", "NSFX", "TYPE", "NOTE", "SOUR"];

/**
 * Detect, per variant, how the master writes it — a separate `TYPE` record or an
 * inline tag — by tallying both across the file. The dominant form wins; for the
 * record form the most-used `TYPE` spelling is kept (so incoming records are
 * recased to it), and for the tag form the most-used tag.
 */
export function inferNameVariants(dataset: Dataset): NameProfile {
  // kind -> tag/type string -> count
  const tagCounts: Record<NameVariantKind, Map<string, number>> = blankCounts();
  const typeCounts: Record<NameVariantKind, Map<string, number>> = blankCounts();

  walkNodes(dataset.records, (node) => {
    if (node.tag !== "NAME") return;
    const type = node.children.find((c) => c.tag === "TYPE")?.value?.trim();
    for (const kind of KINDS) {
      const spec = VARIANTS[kind];
      if (type && spec.types.includes(type.toLowerCase())) bump(typeCounts[kind], type);
      for (const child of node.children) {
        if (spec.tags.includes(child.tag) && child.value?.trim()) bump(tagCounts[kind], child.tag);
      }
    }
  });

  const profile = {} as NameProfile;
  for (const kind of KINDS) {
    const tags = total(tagCounts[kind]);
    const records = total(typeCounts[kind]);
    if (tags === 0 && records === 0) profile[kind] = { form: "none" };
    else if (tags >= records) profile[kind] = { form: "tag", tag: mostFrequent(tagCounts[kind]) };
    else profile[kind] = { form: "record", type: mostFrequent(typeCounts[kind]) };
  }
  return profile;
}

/** The married variant mapped to the loader's headline {@link NameLayout}. */
export function nameLayoutOf(profile: NameProfile): NameLayout {
  const married = profile.married;
  if (married.form === "tag") return "marnm";
  if (married.form === "record") return "married-name";
  return "none";
}

/** Married convention of a dataset, for the loader's "Name format" line. */
export function inferNameLayout(dataset: Dataset): NameLayout {
  return nameLayoutOf(inferNameVariants(dataset));
}

/**
 * Reshape one individual's alternate names into the master's convention, in
 * place. Returns a before/after change per item rewritten (for the load report).
 */
export function reshapeNameVariants(indi: GedNode, profile: NameProfile): NormChange[] {
  const primary = indi.children.find((c) => c.tag === "NAME");
  if (!primary) return [];
  const changes: NormChange[] = [];
  for (const kind of KINDS) {
    const target = profile[kind];
    if (target.form === "none") continue;
    if (target.form === "record") toRecord(indi, primary, VARIANTS[kind], target, changes);
    else toTag(indi, primary, VARIANTS[kind], target, changes);
  }
  return changes;
}

/** Master uses `TYPE` records: fold inline tags into records and recase existing records. */
function toRecord(indi: GedNode, primary: GedNode, spec: VariantSpec, target: NameVariantTarget, changes: NormChange[]): void {
  const typeValue = target.type!;
  // Inline tags on the primary name → separate records.
  for (const tagChild of primary.children.filter((c) => spec.tags.includes(c.tag) && c.value?.trim())) {
    const text = spec.slot === "surname" ? surnameOfValue(tagChild.value!) : givenOfValue(tagChild.value!);
    primary.children = primary.children.filter((c) => c !== tagChild);
    if (!text) continue;
    addRecord(indi, spec.slot, text, typeValue);
    changes.push({ before: `${tagChild.tag} ${tagChild.value!.trim()}`, after: `${recordValue(spec.slot, text)} (${typeValue})` });
  }
  // Existing records of this kind → recase/unify the TYPE token to the master's.
  for (const rec of indi.children) {
    if (rec === primary || rec.tag !== "NAME") continue;
    const typeNode = rec.children.find((c) => c.tag === "TYPE");
    const tv = typeNode?.value?.trim();
    if (!tv || !spec.types.includes(tv.toLowerCase()) || tv === typeValue) continue;
    changes.push({ before: `(${tv})`, after: `(${typeValue})` });
    typeNode!.value = typeValue;
  }
}

/** Master uses an inline tag: fold records into the tag (when lossless) and rename sibling tags. */
function toTag(indi: GedNode, primary: GedNode, spec: VariantSpec, target: NameVariantTarget, changes: NormChange[]): void {
  const tag = target.tag!;
  for (const rec of indi.children.filter((c) => c !== primary && c.tag === "NAME" && hasType(c, spec))) {
    const { given, surname } = nameParts(rec);
    let text: string | undefined;
    if (spec.slot === "surname") {
      text = surname; // a record's own given is the person's; the tag carries only the surname
    } else if (!surname) {
      text = given; // given-slot tags can't hold a surname — keep such records as records
    }
    if (!text) continue;
    indi.children = indi.children.filter((c) => c !== rec);
    addTag(primary, tag, text);
    changes.push({ before: `${displayName(rec)} (${typeOf(rec)})`, after: `${tag} ${text}` });
  }
  // A sibling tag for the same kind (e.g. `_AKAN` when the master uses `_AKA`) → canonical tag.
  for (const child of primary.children) {
    if (child.tag !== tag && spec.tags.includes(child.tag) && child.value?.trim()) {
      changes.push({ before: child.tag, after: tag });
      child.tag = tag;
    }
  }
}

// --- node helpers ----------------------------------------------------------

function addRecord(indi: GedNode, slot: Slot, text: string, typeValue: string): void {
  const node: GedNode = {
    level: indi.level + 1, tag: "NAME", value: recordValue(slot, text),
    children: [{ level: indi.level + 2, tag: "TYPE", value: typeValue, children: [] }],
  };
  const names = indi.children.filter((c) => c.tag === "NAME");
  const last = names[names.length - 1];
  indi.children.splice(indi.children.indexOf(last) + 1, 0, node);
}

function addTag(primary: GedNode, tag: string, value: string): void {
  if (primary.children.some((c) => c.tag === tag && c.value?.trim() === value)) return; // no exact dup
  insertOrdered(primary, { level: primary.level + 1, tag, value, children: [] });
}

function recordValue(slot: Slot, text: string): string {
  return slot === "surname" ? `/${text}/` : `${text} //`;
}

function hasType(node: GedNode, spec: VariantSpec): boolean {
  const tv = node.children.find((c) => c.tag === "TYPE")?.value?.trim().toLowerCase();
  return !!tv && spec.types.includes(tv);
}

function typeOf(node: GedNode): string {
  return node.children.find((c) => c.tag === "TYPE")?.value?.trim() ?? "";
}

function nameParts(node: GedNode): { given?: string; surname?: string } {
  const slash = node.value?.match(/^(.*?)\/([^/]*)\//);
  const given = (slash ? slash[1].trim() : node.value?.trim()) || node.children.find((c) => c.tag === "GIVN")?.value?.trim();
  const surname = (slash ? slash[2].trim() : undefined) || node.children.find((c) => c.tag === "SURN")?.value?.trim();
  return { given: given || undefined, surname: surname || undefined };
}

function displayName(node: GedNode): string {
  return (node.value ?? "").replace(/\//g, "").replace(/\s+/g, " ").trim();
}

function surnameOfValue(value: string): string | undefined {
  return value.match(/\/([^/]*)\//)?.[1].trim() || value.trim() || undefined;
}

function givenOfValue(value: string): string | undefined {
  return (value.match(/^(.*?)\//)?.[1].trim() ?? value.trim()) || undefined;
}

function insertOrdered(parent: GedNode, child: GedNode): void {
  const rank = (t: string) => { const i = NAME_CHILD_ORDER.indexOf(t); return i === -1 ? Infinity : i; };
  const at = parent.children.findIndex((c) => rank(c.tag) > rank(child.tag));
  if (at === -1) parent.children.push(child);
  else parent.children.splice(at, 0, child);
}

// --- counting helpers ------------------------------------------------------

function blankCounts(): Record<NameVariantKind, Map<string, number>> {
  return { married: new Map(), birth: new Map(), aka: new Map(), nick: new Map() };
}
function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}
function total(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}
function mostFrequent(m: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [k, c] of m) if (c > bestCount) { best = k; bestCount = c; }
  return best;
}
