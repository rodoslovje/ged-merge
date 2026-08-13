import type { GedNode } from "../gedcom/types";
import { hasChild } from "../gedcom/node";
import { isChangeStampEvent } from "../gedcom/eventTags";
import { vendorTagInfo } from "../gedcom/vendorTags";
import type { NormChange } from "./types";

/**
 * Software-internal vendor-tag cleanup (custom-tag plan, Phase 5).
 *
 * - `convertUpdToChan`: MyHeritage/Family Historian stamp records with
 *   `1 _UPD 23 JUL 2011 14:39:50 GMT+1` instead of the standard `CHAN`
 *   change-audit structure. When a record carries `_UPD` but no `CHAN`, the
 *   same information is rewritten as `CHAN`/`DATE`/`TIME` in place (the time
 *   zone suffix, which CHAN cannot express, is dropped). A record that already
 *   has a `CHAN` keeps its `_UPD` untouched — the strip pass below can remove
 *   it on request.
 * - `stripInternalTags`: removes every subtree whose tag the vendor registry
 *   classifies as `internal` — pure software bookkeeping with no genealogical
 *   content (`_UPD`, `_RINS`, `_COLOR*`, `_FLGS`/`__FLAG_n`, `_EVN`, …).
 *   Deliberately lossy, so it only runs when the user opts in (the
 *   bulk-normalize checkbox); load-time normalization never strips.
 *
 * Both operate on INDI/FAM records only — header, sources, notes and media
 * records keep their vendor bookkeeping untouched.
 */

/** `_UPD` value shape: `9 MAY 2022 04:35:16 GMT -0500` / `23 JUL 2011 14:39:50 GMT+1`. */
const UPD_RE = /^(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/;

/** Rewrite `_UPD` timestamps into standard `CHAN` structures (see module doc).
 *  Both of MyHeritage's spellings count — the `_UPD` tag and the older
 *  `1 EVEN <timestamp>` + `2 TYPE _UPD` event, which carries the same stamp
 *  and would otherwise survive as a life event with a timestamp for a name. */
export function convertUpdToChan(records: GedNode[]): NormChange[] {
  const changes: NormChange[] = [];
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const upd = rec.children.find((c) => (c.tag === "_UPD" || isChangeStampEvent(c)) && c.value?.trim());
    if (!upd || hasChild(rec, "CHAN")) continue;
    const m = UPD_RE.exec(upd.value!.trim());
    if (!m) continue;
    const [, date, time] = m;
    const before = `${upd.tag === "_UPD" ? "_UPD" : "EVEN (TYPE _UPD)"} ${m[0]}`;
    // Replace the stamp node in place so it keeps its position.
    upd.tag = "CHAN";
    upd.value = undefined;
    upd.children = [
      { level: 0, tag: "DATE", value: date.toUpperCase(), children: time ? [{ level: 0, tag: "TIME", value: time, children: [] }] : [] },
    ];
    changes.push({ before, after: `CHAN ${date.toUpperCase()}` });
  }
  return changes;
}

/** Remove registry-`internal` vendor subtrees from INDI/FAM records (see module doc). */
export function stripInternalTags(records: GedNode[]): NormChange[] {
  const changes: NormChange[] = [];
  const strip = (node: GedNode): void => {
    const kept: GedNode[] = [];
    for (const child of node.children) {
      // A custom event the registry calls internal (MyHeritage's `TYPE _UPD`
      // stamp) is bookkeeping just as much as an internal tag is.
      if (vendorTagInfo(child.tag)?.category === "internal" || isChangeStampEvent(child)) {
        const label = isChangeStampEvent(child) ? "EVEN (TYPE _UPD)" : child.tag;
        changes.push({ before: child.value?.trim() ? `${label} ${child.value.trim()}` : label, after: "(removed)" });
        continue;
      }
      strip(child);
      kept.push(child);
    }
    node.children = kept;
  };
  for (const rec of records) {
    if (rec.tag === "INDI" || rec.tag === "FAM") strip(rec);
  }
  return changes;
}
