import { isPresumedLiving } from "./lifespan";
import { cloneNode, firstChild } from "./node";
import type { Dataset, GedNode, Individual } from "./types";
import { isVoidPointer } from "./uri";
import { RESEARCH_TAG } from "./research";
import { VOID_XREF } from "./assoc";
import { versionFamily, type VersionFamily } from "../normalize/migrate";
import { reducedName, type LivingNameMode } from "./nameDisplay";

/**
 * Branch export: cut a shareable GEDCOM out of the main file containing
 * exactly the people shown in a chart (plus whatever is needed to keep the
 * file valid and self-contained). The recipient loads it in GED Merge as a
 * compare file and merges it into their own main.
 *
 * What goes in, given a set of individual ids:
 * - the INDI records for those ids, in original file order;
 * - every FAM record with at least two included members (spouses/children) —
 *   the families that actually connect two exported people. A family with a
 *   single included member carries no relationship, so it is dropped rather
 *   than exported as a husk;
 * - supporting records the kept records point to, transitively: sources with
 *   their repositories, shared notes, media records, the header's submitter;
 * - a clone of the main's HEAD (so version/charset conventions carry over)
 *   and the TRLR.
 *
 * Every pointer to a person or family outside the branch — a FAMS to a dropped
 * family, a CHIL to an excluded sibling, an ASSO or `_ASSO` to a person outside
 * the branch — is scrubbed first, at any depth, so nothing cited only beneath
 * it comes along. Then every remaining pointer whose target did not make it
 * into the output is scrubbed too, so the file never contains dangling xrefs.
 * Other vendor-extension (`_`) pointers are left untouched (their vocabulary
 * is not ours to edit), but their targets still count as reachable and are
 * carried along when they are supporting records.
 *
 * With `redactLiving` (the charts' "living people private" setting), a living
 * or private-flagged person is written as `NAME <living>` — or the part of the
 * name `livingName` keeps — with only SEX, FAMC and FAMS, and the
 * family of a couple with such a spouse with only HUSB, WIFE and CHIL.
 */

export interface BranchExport {
  /** Cloned records ready to serialize — the source dataset is not touched. */
  records: GedNode[];
  /** People exported. */
  individuals: number;
  /** Connecting FAM records exported. */
  families: number;
  /** Supporting records carried along (SOUR / NOTE / OBJE / REPO / SUBM …). */
  supporting: number;
}

/** A standalone pointer value (`@X1@`), as opposed to a `@#…@` escape. 7.0's
 *  `@VOID@` points nowhere on purpose, so it is no pointer to follow or scrub:
 *  a citation `SOUR @VOID@` keeps its PAGE and PHRASE. */
function pointerValue(node: GedNode): string | undefined {
  const v = node.value?.trim();
  return v && /^@[^@]+@$/.test(v) && !v.startsWith("@#") && !isVoidPointer(v) ? v : undefined;
}

/** What a redacted record keeps: who it is related to and, for a person, the sex. */
const REDACTED_INDI_KEEPS = new Set(["SEX", "FAMC", "FAMS"]);
const REDACTED_FAM_KEEPS = new Set(["HUSB", "WIFE", "CHIL"]);
/** The name a redacted person is written with. */
export const REDACTED_NAME = "<living>";

/** A person the charts hide when living people are kept private. */
const hiddenLiving = (indi: Individual | undefined, ds: Dataset): boolean =>
  !!indi && (isPresumedLiving(indi, ds) || !!indi.private);

/** The NAME a redacted person is written with: the part of the name the
 *  privacy choice keeps, as the charts show it — the initials (`A. /N./`),
 *  the given name, or the record's own name. A person flagged private, or
 *  one with nothing to keep, gets {@link REDACTED_NAME}. */
function keptNameValue(rec: GedNode, indi: Individual | undefined, mode: LivingNameMode | undefined): string {
  if (!indi || indi.private || !mode || mode === "anonymous") return REDACTED_NAME;
  if (mode === "name") return firstChild(rec, "NAME")?.value?.trim() || REDACTED_NAME;
  const kept = reducedName(indi.names[0], mode);
  if (!kept) return REDACTED_NAME;
  return [kept.given, kept.surname && `/${kept.surname}/`].filter(Boolean).join(" ");
}

export function extractBranch(
  ds: Dataset,
  personIds: Iterable<string>,
  opts: {
    redactLiving?: boolean;
    /** With `redactLiving`: how much of a living person's name is kept (the
     *  charts' privacy choice). Default: none — the {@link REDACTED_NAME}. */
    livingName?: LivingNameMode;
    /** The version the export is written in (default: the file's own). It
     *  decides how a sealing whose family is left out is kept. */
    version?: VersionFamily;
  } = {},
): BranchExport {
  const version = opts.version ?? versionFamily(ds.version);
  const keepIndi = new Set<string>();
  for (const id of personIds) if (ds.individuals.has(id)) keepIndi.add(id);

  // A family earns its place by connecting two exported people.
  const keepFam = new Set<string>();
  for (const fam of ds.families.values()) {
    const members = [fam.husband, fam.wife, ...fam.children];
    const included = members.filter((id) => id && keepIndi.has(id)).length;
    if (included >= 2) keepFam.add(fam.id);
  }

  const byXref = new Map<string, GedNode>();
  for (const rec of ds.records) if (rec.xref) byXref.set(rec.xref, rec);

  // First drop every pointer to a person or family left out of the branch, at
  // any depth and inside vendor subtrees too (`_ASSO @I9@` names a person as
  // surely as `ASSO` does). Only then are the supporting records chased, on
  // these scrubbed copies — a source cited only under a dropped `ASSO` belongs
  // to someone outside the branch and must not come along.
  const isOutsider = (v: string): boolean => {
    const tag = byXref.get(v)?.tag;
    return (tag === "INDI" && !keepIndi.has(v)) || (tag === "FAM" && !keepFam.has(v));
  };
  const scrubOutsiders = (node: GedNode): void => {
    node.children = node.children.filter((child) => {
      // The reader's research notes stay home: dropped here, before the
      // supporting records are chased, so a note's media does not come along.
      if (child.tag === RESEARCH_TAG) return false;
      const v = pointerValue(child);
      if (v && isOutsider(v)) return false;
      // A child-to-parents sealing requires its FAMC: with the family outside
      // the branch, 7.0 points it at `@VOID@`; 5.5.1 has no such pointer, so
      // the sealing goes.
      const famc = child.tag === "SLGC" ? firstChild(child, "FAMC") : undefined;
      const famcTarget = famc && pointerValue(famc);
      if (famc && famcTarget && isOutsider(famcTarget)) {
        if (version !== "7.0") return false;
        famc.value = VOID_XREF;
      }
      scrubOutsiders(child);
      return true;
    });
  };
  // With living people private, as the charts show them, a living person keeps
  // only sex and family links, and a living couple's family only its members —
  // cut before the supporting records are chased, so no source or note cited
  // only by the hidden data comes along.
  const redactedKeeps = (rec: GedNode): Set<string> | undefined => {
    if (!opts.redactLiving || !rec.xref) return undefined;
    if (rec.tag === "INDI") return hiddenLiving(ds.individuals.get(rec.xref), ds) ? REDACTED_INDI_KEEPS : undefined;
    const fam = rec.tag === "FAM" ? ds.families.get(rec.xref) : undefined;
    return fam && [fam.husband, fam.wife].some((id) => id && hiddenLiving(ds.individuals.get(id), ds)) ? REDACTED_FAM_KEEPS : undefined;
  };
  const clones = new Map<GedNode, GedNode>();
  const cloneOf = (rec: GedNode): GedNode => {
    let clone = clones.get(rec);
    if (!clone) {
      clone = cloneNode(rec);
      const keeps = redactedKeeps(rec);
      if (keeps) {
        clone.children = clone.children.filter((c) => keeps.has(c.tag));
        // The name says why the rest is missing; matching reads it as a placeholder.
        if (rec.tag === "INDI") {
          const value = keptNameValue(rec, ds.individuals.get(rec.xref!), opts.livingName);
          clone.children.unshift({ level: 1, tag: "NAME", value, children: [] });
        }
      }
      scrubOutsiders(clone);
      clones.set(rec, clone);
    }
    return clone;
  };

  // Chase pointers out of the kept records (and HEAD) into the supporting
  // records they cite, transitively — SOUR → REPO/NOTE/OBJE, OBJE → NOTE, the
  // header's SUBM, … INDI/FAM targets are never pulled in this way: people are
  // chosen by the caller, families by the ≥2-members rule above.
  const supporting = new Set<string>();
  const queue: GedNode[] = [];
  const head = ds.records.find((r) => r.tag === "HEAD");
  if (head) queue.push(cloneOf(head));
  for (const rec of ds.records) {
    if (rec.xref && (keepIndi.has(rec.xref) || keepFam.has(rec.xref))) queue.push(cloneOf(rec));
  }
  const chase = (node: GedNode) => {
    const v = pointerValue(node);
    if (v && !keepIndi.has(v) && !keepFam.has(v) && !supporting.has(v)) {
      const target = byXref.get(v);
      if (target && target.tag !== "INDI" && target.tag !== "FAM") {
        supporting.add(v);
        queue.push(cloneOf(target));
      }
    }
    for (const child of node.children) chase(child);
  };
  // By index, not `shift()`: taking the head off a long array moves every
  // record behind it, each time — a minute for a branch of 200,000 people.
  for (let at = 0; at < queue.length; at++) chase(queue[at]);

  const kept = new Set([...keepIndi, ...keepFam, ...supporting]);

  // Drop any pointer line whose target is not in the output. Vendor (`_`)
  // subtrees are skipped, mirroring the dangling-xref validator: their
  // contents follow the vendor's own vocabulary.
  const scrub = (node: GedNode): void => {
    node.children = node.children.filter((child) => {
      if (child.tag.startsWith("_")) return true;
      const v = pointerValue(child);
      if (v && !kept.has(v)) return false;
      scrub(child);
      return true;
    });
  };

  const records: GedNode[] = [];
  for (const rec of ds.records) {
    const keep =
      rec.tag === "HEAD" || rec.tag === "TRLR" || (rec.xref !== undefined && kept.has(rec.xref));
    if (!keep) continue;
    const clone = cloneOf(rec);
    scrub(clone);
    records.push(clone);
  }

  return { records, individuals: keepIndi.size, families: keepFam.size, supporting: supporting.size };
}
