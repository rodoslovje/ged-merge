import type { GedNode } from "../gedcom/types";
import { firstChild } from "../gedcom/node";
import { vendorEventTypeInfo } from "../gedcom/vendorTags";

/**
 * Family-status and child-pedigree normalization (custom-tag plan, Phase 3).
 *
 * Different programs encode "this couple were partners, never married" and
 * "this child was adopted" in incompatible vendor vocabularies. These passes
 * consolidate them into one canonical form each, so review rows compare
 * like-for-like and the export carries a single convention:
 *
 * - Partnership status → `1 _MSTAT <value>` on the FAM (Brother's Keeper's
 *   own value-bearing tag, the most common encoding in the wild):
 *   - MyHeritage `1 EVEN` + `2 TYPE MYHERITAGE:REL_PARTNERS/_UNKNOWN`
 *   - Family Tree Maker `1 _STAT <value>`
 *   - a lone valueless Brother's Keeper `1 _NMR` ("never married")
 *   - and, once a `_MSTAT` is present, the redundant BK trio companions
 *     (`_NMR` without value/children, `_MARRIED N`) are dropped.
 * - Child-parent relationship → standard `PEDI` on the child's `FAMC`:
 *   FTM/Ancestry/BK `2 _FREL <rel>` / `2 _MREL <rel>` under `1 CHIL`. Only
 *   when both parents agree (or one side is absent): "adopted"/"foster"
 *   become `PEDI adopted|foster`; the default "Natural"/"birth" pair is pure
 *   noise (FTM writes it on every child) and is dropped. Per-parent
 *   mismatches and unknown vocabularies are left untouched — PEDI cannot
 *   express them.
 *
 * Pure tree rewrites over the cloned record forest; each returns the list of
 * changes for the NormalizationReport.
 */

export interface FamilyStatusChange {
  before: string;
  after: string;
}

const hasMstat = (fam: GedNode): boolean => fam.children.some((c) => c.tag === "_MSTAT");

/** Consolidate vendor partnership-status encodings on FAM records into `_MSTAT`. */
export function normalizeFamilyStatus(records: GedNode[]): FamilyStatusChange[] {
  const changes: FamilyStatusChange[] = [];
  for (const fam of records) {
    if (fam.tag !== "FAM") continue;

    // MyHeritage: `EVEN` + `TYPE MYHERITAGE:REL_*` → `_MSTAT <status>`.
    for (const child of fam.children) {
      if (child.tag !== "EVEN" || hasMstat(fam)) continue;
      const typeNode = firstChild(child, "TYPE");
      const status = vendorEventTypeInfo(typeNode?.value)?.mstat;
      if (!status) continue;
      changes.push({ before: `EVEN — ${typeNode!.value!.trim()}`, after: `_MSTAT ${status}` });
      child.tag = "_MSTAT";
      child.value = status;
      child.children = child.children.filter((c) => c !== typeNode);
    }

    // Family Tree Maker: `_STAT <value>` → `_MSTAT <value>` (pure rename, but
    // only on FAM records — hence here and not in VENDOR_TAG_ALIASES).
    for (const child of fam.children) {
      if (child.tag !== "_STAT" || !child.value?.trim() || hasMstat(fam)) continue;
      changes.push({ before: `_STAT ${child.value.trim()}`, after: `_MSTAT ${child.value.trim()}` });
      child.tag = "_MSTAT";
    }

    // Brother's Keeper: a lone `_NMR` (never married) carries the whole
    // assertion itself → `_MSTAT Partners`. Only the plain flag form — a
    // value would be lost by the rewrite, so anything else stays.
    for (const child of fam.children) {
      if (child.tag !== "_NMR" || child.value?.trim() || hasMstat(fam)) continue;
      changes.push({ before: "_NMR", after: "_MSTAT Partners" });
      child.tag = "_MSTAT";
      child.value = "Partners";
    }

    // With a `_MSTAT` in place, the BK trio companions restate it — drop the
    // bare ones (no value, no children) so the file keeps one encoding.
    if (hasMstat(fam)) {
      fam.children = fam.children.filter((c) => {
        const bareNmr = c.tag === "_NMR" && !c.value?.trim() && c.children.length === 0;
        const marriedN = c.tag === "_MARRIED" && c.value?.trim().toUpperCase() === "N" && c.children.length === 0;
        if (bareNmr || marriedN) {
          changes.push({ before: c.tag === "_NMR" ? "_NMR" : "_MARRIED N", after: "(covered by _MSTAT)" });
          return false;
        }
        return true;
      });
    }
  }
  return changes;
}

/** _FREL/_MREL vocabularies that map onto a PEDI value. */
function canonicalRelation(value: string | undefined): "birth" | "adopted" | "foster" | undefined {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "natural" || v === "birth" || v === "biological") return "birth";
  if (v === "adopted") return "adopted";
  if (v === "foster") return "foster";
  return undefined;
}

/** Convert agreeing `_FREL`/`_MREL` pairs under `FAM.CHIL` into standard
 *  `PEDI` on the child's `FAMC` link (or drop the default birth/birth pair). */
export function normalizePedigree(records: GedNode[]): FamilyStatusChange[] {
  const changes: FamilyStatusChange[] = [];
  const byXref = new Map<string, GedNode>();
  for (const r of records) if (r.xref) byXref.set(r.xref, r);

  for (const fam of records) {
    if (fam.tag !== "FAM" || !fam.xref) continue;
    for (const chil of fam.children) {
      if (chil.tag !== "CHIL") continue;
      const frel = firstChild(chil, "_FREL");
      const mrel = firstChild(chil, "_MREL");
      if (!frel && !mrel) continue;
      // Anything with substructure of its own is more than a flag — keep it.
      if (frel?.children.length || mrel?.children.length) continue;
      const f = frel ? canonicalRelation(frel.value) : undefined;
      const m = mrel ? canonicalRelation(mrel.value) : undefined;
      if ((frel && !f) || (mrel && !m)) continue; // unknown vocabulary
      if (f && m && f !== m) continue; // per-parent mismatch — PEDI can't say it
      const rel = (f ?? m)!;

      const label = [frel && `_FREL ${frel.value?.trim()}`, mrel && `_MREL ${mrel.value?.trim()}`]
        .filter(Boolean)
        .join(" + ");

      if (rel !== "birth") {
        // Write the standard PEDI on the child's FAMC link (never overwrite one).
        const indi = chil.value ? byXref.get(chil.value.trim()) : undefined;
        const famc = indi?.children.find((c) => c.tag === "FAMC" && c.value?.trim() === fam.xref);
        if (!famc) continue;
        if (!famc.children.some((c) => c.tag === "PEDI")) {
          famc.children.unshift({ level: 0, tag: "PEDI", value: rel, children: [] });
        }
        changes.push({ before: label, after: `PEDI ${rel}` });
      } else {
        // birth/birth is the default relationship — the tags say nothing.
        changes.push({ before: label, after: "(removed — default)" });
      }
      chil.children = chil.children.filter((c) => c !== frel && c !== mrel);
    }
  }
  return changes;
}
