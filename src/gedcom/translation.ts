import { firstChild } from "./node";
import { parseName } from "./name";
import type { GedNode, NameTranslation, Translation } from "./types";

/**
 * Translations of a name, a place or a note: GEDCOM 7's `TRAN` with its `LANG`
 * (`2 TRAN Иван /Новак/` · `3 LANG ru`), and 5.5.1's own forms of the same
 * thing — a name's or place's romanized (`ROMN`) and phonetic (`FONE`)
 * variants, typed by their `TYPE`, which the version migration turns into
 * `TRAN` and back. A note's translation downgraded to 5.5.1 is `_TRAN`, and
 * reads alike.
 */

/** Tags carrying a translation, in either dialect. */
export const TRANSLATION_TAGS: readonly string[] = ["TRAN", "ROMN", "FONE", "_TRAN"];

/** The language (or 5.5.1 variant type) a translation line names. */
function langOf(node: GedNode): string | undefined {
  return (firstChild(node, ["LANG", "_LANG"]) ?? firstChild(node, "TYPE"))?.value?.trim() || undefined;
}

/** Every translation of a place or a note line, in file order. */
export function translationsOf(node: GedNode): Translation[] {
  const out: Translation[] = [];
  for (const c of node.children) {
    if (!TRANSLATION_TAGS.includes(c.tag) || !c.value?.trim()) continue;
    const lang = langOf(c);
    out.push(lang ? { value: c.value, lang } : { value: c.value });
  }
  return out;
}

/** Every translation of a `NAME` line, parsed into its parts like the name itself. */
export function nameTranslationsOf(nameNode: GedNode): NameTranslation[] {
  const out: NameTranslation[] = [];
  for (const c of nameNode.children) {
    if (!TRANSLATION_TAGS.includes(c.tag) || !c.value?.trim()) continue;
    const parts = new Map<string, string>();
    for (const p of c.children) if (p.value !== undefined) parts.set(p.tag, p.value.trim());
    const n = parseName(c.value, parts);
    const tr: NameTranslation = { full: n.full };
    if (n.given) tr.given = n.given;
    if (n.surname) tr.surname = n.surname;
    const lang = langOf(c);
    if (lang) tr.lang = lang;
    out.push(tr);
  }
  return out;
}

/** "Иван Новак (ru)" — a translation as one readable line. */
export function translationLine(text: string, lang: string | undefined): string {
  return lang ? `${text} (${lang})` : text;
}
