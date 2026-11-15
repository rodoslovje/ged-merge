import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { addFamilyChild, addFamilyLink, rebuildFamily, rebuildIndividual, setFamilySpouse } from "../gedcom/edit";
import { cloneNode } from "../gedcom/node";
import { isVoidPointer } from "../gedcom/uri";
import { type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "Broken links" health-check category.
 *
 * Repairs rather than deletes: a family link is a claim about the family, and
 * a claim one side makes and the other leaves out is completed, not thrown
 * away. Mirroring `validateDataset`'s `brokenLink` findings:
 *
 *  - **One-way** — the target exists but doesn't point back. The missing
 *    back-pointer is added: a person's `FAMC` gets the family's `CHIL` (in
 *    birth order among the children), a person's `FAMS` the family's `HUSB` or
 *    `WIFE`, and a family's `HUSB`/`WIFE`/`CHIL` the person's `FAMS`/`FAMC`,
 *    each placed by `FAM_CHILD_ORDER`/`INDI_CHILD_ORDER`.
 *  - **Dangling** — `FAMC`/`FAMS` on an individual (or `HUSB`/`WIFE`/`CHIL` on
 *    a family) whose target xref isn't in the dataset. There is nothing to
 *    point back from, so the line is removed.
 *
 * The spouse slot comes from the person's `SEX` (M → `HUSB`, F → `WIFE`); with
 * no usable sex it is the one free slot. Where that slot already names someone
 * (another person, or `@VOID@`), or both are free and the sex is unknown, the
 * one-way `FAMS` is **left as it is** and stays reported: filling the slot
 * would mean replacing a spouse or guessing one's role, and removing the line
 * would lose the only record that the person belongs to that family. The user
 * settles it in Edit; {@link spouseSlotFor} answers which case a finding is.
 *
 * Idempotent: once a link is mutual, or gone, nothing is left to repair.
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `applyPlaceRename`.
 *
 * Runs over the whole file (the "Fix all broken links" button) or over a single
 * pointer (`only`), which is what a health-check finding's own fix button uses —
 * the finding names one record and one target, and repairs just that.
 */

/** One broken pointer: the record carrying it, and the xref it points at. */
export interface BrokenLinkRef {
  /** Record the pointer line sits on — an individual or a family. */
  id: string;
  /** Pointer target xref; omitted, every broken pointer on the record goes. */
  target?: string;
}

/** The xrefs the family's `tag` lines name, trimmed as the builder reads them.
 *  7.0's `@VOID@` is among them: it names no record, but it holds the slot. */
function slotValues(fam: Family, tag: "HUSB" | "WIFE"): string[] {
  return fam.raw.children.filter((c) => c.tag === tag && c.value?.trim()).map((c) => c.value!.trim());
}

/**
 * The spouse line a person's one-way `FAMS` would be answered with on `fam`,
 * or undefined when it can't be without replacing someone or guessing: the
 * slot their sex names is taken, or the sex is unknown and not exactly one
 * slot is free. `gone` lists xrefs about to be removed, whose slot is free.
 */
export function spouseSlotFor(indi: Individual, fam: Family, gone: ReadonlySet<string> = new Set()): "HUSB" | "WIFE" | undefined {
  const free = (tag: "HUSB" | "WIFE") => slotValues(fam, tag).every((v) => gone.has(v));
  if (indi.sex === "M") return free("HUSB") ? "HUSB" : undefined;
  if (indi.sex === "F") return free("WIFE") ? "WIFE" : undefined;
  const husb = free("HUSB");
  const wife = free("WIFE");
  return husb !== wife ? (husb ? "HUSB" : "WIFE") : undefined;
}

/** Remove every `tag` child of `node` whose pointer value is in `deadValues`. */
function pruneRefs(node: GedNode, tag: string, deadValues: Set<string>): boolean {
  const before = node.children.length;
  // Compared trimmed, as the builder reads them: `1 FAMC @F9@ ` points at @F9@.
  node.children = node.children.filter((c) => !(c.tag === tag && c.value !== undefined && deadValues.has(c.value.trim())));
  return node.children.length !== before;
}

export function fixBrokenLinks(dataset: Dataset, only?: BrokenLinkRef): RecordPatch[] {
  /** Is this broken pointer in scope — i.e. the one the caller asked for? */
  const inScope = (recordId: string, target: string) =>
    !only || (only.id === recordId && (only.target === undefined || only.target === target));

  // Every decision is taken from the file as it was read, then applied: the
  // typed model goes stale as soon as one line changes.
  const removals = new Map<Individual | Family, { tag: string; dead: Set<string> }[]>();
  const remove = (rec: Individual | Family, tag: string, dead: Set<string>) => {
    if (dead.size) removals.set(rec, [...(removals.get(rec) ?? []), { tag, dead }]);
  };
  const additions: (() => void)[] = [];
  const touched = new Set<Individual | Family>();

  // Dangling pointers from the family side, first: a spouse slot that names a
  // missing person is free for the person who claims it.
  const goneFrom = new Map<Family, Set<string>>();
  for (const fam of dataset.families.values()) {
    if (only && only.id !== fam.id) continue;
    const deadSpouses = new Set<string>();
    const deadChildren = new Set<string>();
    for (const tag of ["HUSB", "WIFE"] as const) {
      for (const ref of slotValues(fam, tag)) {
        if (!isVoidPointer(ref) && !dataset.individuals.has(ref) && inScope(fam.id, ref)) deadSpouses.add(ref);
      }
    }
    for (const childId of fam.children) {
      if (!dataset.individuals.has(childId) && inScope(fam.id, childId)) deadChildren.add(childId);
    }
    goneFrom.set(fam, deadSpouses);
    remove(fam, "HUSB", deadSpouses);
    remove(fam, "WIFE", deadSpouses);
    remove(fam, "CHIL", deadChildren);
  }

  /** Pairs already answered in this run, so a repeated line adds one pointer. */
  const answered = new Set<string>();
  const once = (key: string) => !answered.has(key) && !!answered.add(key);

  for (const indi of dataset.individuals.values()) {
    if (only && only.id !== indi.id) continue;
    const deadFamc = new Set<string>();
    const deadFams = new Set<string>();

    for (const famId of indi.childOf) {
      if (!inScope(indi.id, famId)) continue;
      const fam = dataset.families.get(famId);
      if (!fam) deadFamc.add(famId);
      else if (!fam.children.includes(indi.id) && once(`${famId}\0CHIL\0${indi.id}`)) {
        additions.push(() => addFamilyChild(dataset, fam, indi.id));
        touched.add(fam);
      }
    }
    for (const famId of indi.spouseOf) {
      if (!inScope(indi.id, famId)) continue;
      const fam = dataset.families.get(famId);
      if (!fam) {
        deadFams.add(famId);
        continue;
      }
      if (slotValues(fam, "HUSB").includes(indi.id) || slotValues(fam, "WIFE").includes(indi.id)) continue;
      const slot = spouseSlotFor(indi, fam, goneFrom.get(fam));
      // Taken, a guess, or claimed by someone else in this run: left as it
      // is (see the header).
      if (!slot || !once(`${famId}\0${slot}`)) continue;
      additions.push(() => setFamilySpouse(fam, slot, indi.id));
      touched.add(fam);
    }
    remove(indi, "FAMC", deadFamc);
    remove(indi, "FAMS", deadFams);
  }

  // One-way links from the family side: the person gets the FAMC/FAMS back.
  for (const fam of dataset.families.values()) {
    if (only && only.id !== fam.id) continue;
    const links: [string, "FAMC" | "FAMS"][] = [
      ...fam.children.map((id) => [id, "FAMC"] as [string, "FAMC"]),
      ...[...slotValues(fam, "HUSB"), ...slotValues(fam, "WIFE")].map((id) => [id, "FAMS"] as [string, "FAMS"]),
    ];
    for (const [indiId, tag] of links) {
      const indi = dataset.individuals.get(indiId);
      if (!indi || !inScope(fam.id, indiId)) continue;
      if ((tag === "FAMC" ? indi.childOf : indi.spouseOf).includes(fam.id)) continue;
      if (!once(`${indiId}\0${tag}\0${fam.id}`)) continue;
      additions.push(() => addFamilyLink(indi, tag, fam.id));
      touched.add(indi);
    }
  }

  for (const rec of removals.keys()) touched.add(rec);
  if (touched.size === 0) return [];
  const before = new Map([...touched].map((rec) => [rec, cloneNode(rec.raw)]));
  // Removals first, so a freed spouse slot is free when it is filled.
  for (const [rec, list] of removals) for (const { tag, dead } of list) pruneRefs(rec.raw, tag, dead);
  for (const add of additions) add();

  const patches: RecordPatch[] = [];
  for (const rec of touched) {
    const isIndi = dataset.individuals.get(rec.id) === rec;
    if (isIndi) rebuildIndividual(dataset, rec as Individual);
    else rebuildFamily(dataset, rec as Family);
    patches.push({ type: isIndi ? "individual" : "family", id: rec.id, before: before.get(rec)!, after: cloneNode(rec.raw) });
  }
  return patches;
}
