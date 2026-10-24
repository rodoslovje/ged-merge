import type { GedNode } from "./types";
import { childValue, firstChild } from "./node";
import { sourceTitle } from "./source";

/**
 * What a person reading a list would call a record that is not a person or a
 * family: a source by its title, a media object by its title or else its file
 * name, a repository or submitter by its name, a note by its opening words.
 * Undefined when the record says nothing of itself — the caller falls back to
 * its id.
 */
export function recordTitle(node: GedNode): string | undefined {
  switch (node.tag) {
    case "SOUR":
      return sourceTitle(node);
    case "OBJE": {
      const file = firstChild(node, "FILE");
      // The FILE's own title first, as the rest of the app reads it (objeInfoOf).
      const title = (file && childValue(file, "TITL")?.trim()) || childValue(node, "TITL")?.trim();
      const path = file?.value?.trim();
      return title || (path ? path.split(/[\\/]/).pop() : undefined);
    }
    case "REPO":
    case "SUBM":
      return childValue(node, "NAME")?.trim() || undefined;
    case "NOTE": {
      const text = node.value?.trim();
      return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : undefined;
    }
    default:
      return undefined;
  }
}

/** A lookup of the file's level-0 records by xref, built once per record list
 *  — and again when an xref is missing, since the list is edited in place. */
const indexes = new WeakMap<GedNode[], Map<string, GedNode>>();
export function recordByXref(records: GedNode[], xref: string): GedNode | undefined {
  const build = () => {
    const index = new Map(records.filter((r) => r.xref).map((r) => [r.xref!, r]));
    indexes.set(records, index);
    return index;
  };
  return (indexes.get(records) ?? build()).get(xref) ?? build().get(xref);
}
