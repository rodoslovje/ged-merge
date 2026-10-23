import { parseDate } from "./date";
import { firstChild } from "./node";
import type { GedDate, GedNode } from "./types";

/**
 * GEDCOM 7's `PHRASE`: the file's own wording beside a coded value — a date
 * ("Easter Sunday 1850" under `DATE 1850`, or under an empty `DATE` when the
 * wording is all there is), a name type (`TYPE OTHER` · "Klostername"), an
 * association role (read by `gedcom/assoc`). The coded value is what the app
 * computes with; the phrase is what it shows a reader beside it, and every
 * edit that keeps the value keeps the phrase.
 */

/** The `PHRASE` under a line, trimmed, if it has one. */
export function phraseOf(node: GedNode | undefined): string | undefined {
  return (node && firstChild(node, "PHRASE")?.value?.trim()) || undefined;
}

/** A `DATE` line read with its phrase: a date with a payload, one with only a
 *  phrase (7.0 allows an empty payload then), or nothing. */
export function parseDateNode(node: GedNode | undefined): GedDate | undefined {
  if (!node) return undefined;
  const phrase = phraseOf(node);
  if (!node.value?.trim() && !phrase) return undefined;
  const date = parseDate(node.value ?? "");
  if (phrase) date.phrase = phrase;
  return date;
}
