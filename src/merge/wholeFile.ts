import { firstChild } from "../gedcom/node";
import type { Dataset, Family, GedNode } from "../gedcom/types";
import { applyFamilyStructure, findMainSpouseFamily, type MergeContext } from "./applyRelations";
import { cloneNodeRemapped, collectCustomTags, stripForeignPointers } from "./applyFields";

/**
 * A whole-file merge's structural pass: bring every incoming person and every
 * incoming family across.
 *
 * Everyone is resolved first, in the incoming file's order — joined to the main
 * record a confirmed pair (or, by the caller's choice, a candidate passing the
 * identity checks) names, or added as a new record — so each incoming person
 * stands for exactly one record from then on. Then each incoming family is
 * placed: onto the family the merged tree already has for the same people (one
 * a confirmed decision stitched, or one the main file holds), or onto a new
 * family that carries the incoming family's own facts (marriage, divorce,
 * sources, notes). Its spouses and children are linked by the same stitching a
 * confirmed decision uses; where the two files disagree — a slot the main file
 * fills with someone else, a child the main file gives other parents — the
 * main file's word stands and the preview says what was left out.
 *
 * Walking the tree from people (the branch import) would miss what hangs off
 * nobody: a family with children but no parents recorded, a second birth
 * family, a family's own events.
 */
export function applyWholeFile(compare: Dataset, ctx: MergeContext): void {
  for (const incomingId of compare.individuals.keys()) ctx.resolve(incomingId);

  // Families this pass placed, so two incoming families never land on one.
  const claimed = new Set<string>();
  for (const incFam of compare.families.values()) {
    // An empty family record is the health check's finding, not something
    // to copy.
    if (!incFam.husband && !incFam.wife && incFam.children.length === 0) continue;
    const found = existingFamily(incFam, compare, ctx, claimed);
    const target = found ?? createFamilyFrom(incFam, compare, ctx);
    claimed.add(target.xref!);
    applyFamilyStructure(target, incFam, ctx, {
      spouses: true,
      takenChildren: new Set(incFam.children),
      keepIdentity: true,
    });
  }
}

/**
 * The family the merged tree already has for this incoming family's people:
 * the couple's (exactly the same spouses, or the lone family of a person with
 * one marriage on each side — `findMainSpouseFamily`'s rule), or — for a
 * family that names no parent — the one family its children were born into.
 * Never one another incoming family already took: a person with two families
 * of the same shape (two unions with no partner recorded) keeps both.
 */
function existingFamily(incFam: Family, compare: Dataset, ctx: MergeContext, claimed: ReadonlySet<string>): GedNode | undefined {
  const husband = incFam.husband ? ctx.resolved(incFam.husband) : undefined;
  const wife = incFam.wife ? ctx.resolved(incFam.wife) : undefined;
  const anchor = husband ?? wife;
  if (anchor) {
    const other = husband ? wife : undefined;
    // The couple exactly, among the anchor's families still free.
    for (const link of ctx.indiNode(anchor)?.children ?? []) {
      if (link.tag !== "FAMS" || !link.value || claimed.has(link.value)) continue;
      const node = ctx.famNode(link.value);
      if (!node) continue;
      const h = firstChild(node, "HUSB")?.value;
      const w = firstChild(node, "WIFE")?.value;
      if ((h === anchor ? w : h) === other) return node;
    }
    const anchorInc = (husband ? incFam.husband : incFam.wife)!;
    const famCount = compare.individuals.get(anchorInc)?.spouseOf.length ?? 1;
    const lone = findMainSpouseFamily(anchor, other, ctx, famCount);
    return lone && !claimed.has(lone.xref!) ? lone : undefined;
  }
  const birthFamilies = new Set<string>();
  for (const child of incFam.children) {
    const id = ctx.resolved(child);
    const famc = id ? ctx.indiNode(id)?.children.find((c) => c.tag === "FAMC")?.value : undefined;
    if (famc) birthFamilies.add(famc);
  }
  if (birthFamilies.size !== 1) return undefined;
  const [famId] = birthFamilies;
  if (claimed.has(famId)) return undefined;
  const node = ctx.famNode(famId);
  // Only a family without parents of its own: one with parents is a couple the
  // incoming file does not name.
  return node && !firstChild(node, "HUSB") && !firstChild(node, "WIFE") ? node : undefined;
}

/** A new family for an incoming family, carrying everything it records
 *  besides its members: events, sources, notes, media, its own extensions. */
function createFamilyFrom(incFam: Family, compare: Dataset, ctx: MergeContext): GedNode {
  const { node } = ctx.createFamily();
  const facts = cloneNodeRemapped({ ...incFam.raw, children: incFam.raw.children.filter((c) => !MEMBER_TAGS.has(c.tag)) }, ctx.sourXrefMap);
  stripForeignPointers(facts, (xref) => compare.individuals.has(xref) || compare.families.has(xref));
  collectCustomTags(facts, ctx.report.customTags);
  node.children.push(...facts.children);
  return node;
}

const MEMBER_TAGS = new Set(["HUSB", "WIFE", "CHIL"]);
