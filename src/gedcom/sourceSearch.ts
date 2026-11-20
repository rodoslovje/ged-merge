import { childText } from "./node";
import { looseKey, sourceTitle } from "./source";
import type { GedNode } from "./types";

/** One source record of the file as the Add Source dialog's search lists it. */
export interface SourceSearchEntry {
  xref: string;
  /** The title shown — the record's `TITL`, or what stands in for a missing one. */
  title: string;
  author?: string;
  /** The folded title, for ranking a title that starts with the query first. */
  titleKey: string;
  /** Title, author, short title and publisher folded together — what a query is matched against. */
  key: string;
}

/** Letters and digits only, lowercased, without diacritics — so "cerknisko"
 *  finds "Cerkniško" and "Kebe, Janez" finds "Janez Kebe". */
export function foldSourceText(text: string | undefined): string {
  return looseKey(text).normalize("NFD").replace(/\p{M}+/gu, "");
}

/** Every `SOUR` record of the file that has anything to be found by, sorted
 *  by title — built once and searched per keystroke (see {@link searchSources}). */
export function buildSourceSearch(records: GedNode[]): SourceSearchEntry[] {
  const entries: SourceSearchEntry[] = [];
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const title = sourceTitle(rec)?.trim();
    if (!title) continue;
    const author = childText(rec, "AUTH")?.trim() || undefined;
    entries.push({
      xref: rec.xref,
      title,
      author,
      titleKey: foldSourceText(title),
      key: foldSourceText([title, author, childText(rec, "ABBR"), childText(rec, "PUBL")].filter(Boolean).join(" ")),
    });
  }
  return entries.sort((a, b) => a.titleKey.localeCompare(b.titleKey));
}

/**
 * The sources a typed query finds: every word of it must appear somewhere in
 * the source's title, author, short title or publisher. Titles that start
 * with the query come first; the rest follow in title order.
 */
export function searchSources(entries: SourceSearchEntry[], query: string, limit = 8): SourceSearchEntry[] {
  const folded = foldSourceText(query);
  if (folded.length < 2) return [];
  const words = folded.split(" ");
  const leading: SourceSearchEntry[] = [];
  const rest: SourceSearchEntry[] = [];
  for (const entry of entries) {
    if (!words.every((w) => entry.key.includes(w))) continue;
    if (entry.titleKey.startsWith(folded)) {
      leading.push(entry);
      if (leading.length >= limit) break;
    } else if (rest.length < limit) {
      rest.push(entry);
    }
  }
  return [...leading, ...rest].slice(0, limit);
}

/**
 * The source a hand-typed title (and author) already names: same title, and
 * — where both state one — the same author. Two registers can share a title
 * ("Krstna knjiga"), so this only ever proposes; the reader decides.
 */
export function sourceWithTitle(
  entries: SourceSearchEntry[],
  title: string | undefined,
  author: string | undefined,
): SourceSearchEntry | undefined {
  const titleKey = foldSourceText(title);
  if (!titleKey) return undefined;
  const authorKey = foldSourceText(author);
  return entries.find(
    (e) => e.titleKey === titleKey && (!authorKey || !e.author || foldSourceText(e.author) === authorKey),
  );
}
