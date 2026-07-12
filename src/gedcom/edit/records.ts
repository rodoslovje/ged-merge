import { removeChildren } from "../node";
import type { Family, Individual } from "../types";
import { FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered } from "./shared";

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS = ["WWW", "URL", "_URL", "_WEBTAG"];

/** Replace all NOTE records on an individual with the given texts. */
export function setNotes(indi: Individual, notes: string[]): void {
  removeChildren(indi.raw, "NOTE");
  for (const text of notes) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag: "NOTE", value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all NOTE records on a family with the given texts. */
export function setFamilyNotes(fam: Family, notes: string[]): void {
  fam.raw.children = fam.raw.children.filter((c) => c.tag !== "NOTE");
  for (const text of notes) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "NOTE", value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}

/** Replace all top-level link records on an individual (WWW/URL/_URL/_WEBTAG). */
export function setIndividualLinks(indi: Individual, links: string[]): void {
  indi.raw.children = indi.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all top-level link records on a family (WWW/URL/_URL/_WEBTAG). */
export function setFamilyLinks(fam: Family, links: string[]): void {
  fam.raw.children = fam.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}
