import type { GedNode } from "../gedcom/types";
import { isPrivacyMarker, setPrivateFlag, type PrivacyTagStyle } from "../gedcom/private";
import { walkNodes } from "./walk";

/**
 * Privacy-marker dialect normalization.
 *
 * Programs flag private data in incompatible vocabularies — MacFamilyTree's
 * bare `PRIV`, MyHeritage's `_PRIV Y`, the standard `RESN privacy`/
 * `confidential`. When the main file has a dialect of its own, the compare's
 * markers are rewritten to it so a merged export carries one convention (and
 * the main's own program keeps honoring the flags). Non-privacy `RESN` values
 * (`NONE`, `locked`) are not markers and pass through untouched; a marker
 * that's part of a `RESN` list keeps its other entries.
 */
export interface PrivacyStyleChange {
  before: string;
  after: string;
}

const label = (m: GedNode): string => (m.value?.trim() ? `${m.tag} ${m.value.trim()}` : m.tag);

/** Rewrite every privacy marker under `records` into `style` (see module doc). */
export function normalizePrivacyStyle(records: GedNode[], style: PrivacyTagStyle): PrivacyStyleChange[] {
  const changes: PrivacyStyleChange[] = [];
  walkNodes(records, (node) => {
    const markers = node.children.filter(isPrivacyMarker);
    if (!markers.length) return;
    if (markers.length === 1 && markers[0].tag === style) return; // already house style
    const before = markers.map(label).join(" + ");
    setPrivateFlag(node, true, style, records);
    const after = node.children.filter(isPrivacyMarker).map(label).join(" + ");
    changes.push({ before, after });
  });
  return changes;
}
