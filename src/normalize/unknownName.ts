import type { Dataset, GedNode } from "../gedcom/types";
import { isUnknownNameToken } from "../gedcom/name";
import { firstChild } from "../gedcom/node";
import type { NormChange, UnknownNameTarget } from "./types";

/** A file's unknown-name convention plus the marker it uses, for the loader. */
export interface UnknownNameAnalysis {
  /** The reshape target derived from this file (used as the master's convention). */
  target: UnknownNameTarget;
  /** The most-used placeholder token in the file, e.g. "NN". Absent when the
   *  file uses none — unknown name parts are simply left blank. */
  token?: string;
}

/**
 * Detect how a file marks unknown given/surnames. A file is taken to use the
 * `token` convention when explicit placeholder tokens (`NN`, `____`, …) outnumber
 * the *fully blank* names it leaves empty; otherwise it uses the `blank`
 * convention (the default). Only the primary `NAME` of each individual is
 * examined.
 *
 * Half-known names — one real part with the other slot empty ("Janez //") — are
 * ordinary incomplete data, not a statement of convention, so they are *not*
 * counted as blank evidence. In a large genealogy they vastly outnumber explicit
 * tokens and would otherwise drown out a deliberate `NN` convention.
 */
export function analyzeUnknownNames(dataset: Dataset): UnknownNameAnalysis {
  const tokenCounts = new Map<string, number>();
  let blanks = 0;
  for (const indi of dataset.records) {
    if (indi.tag !== "INDI") continue;
    const name = firstChild(indi, "NAME");
    if (!name) continue;
    // The effective (displayed) parts — slash value, falling back to GIVN/SURN —
    // so a placeholder is detected wherever it lives.
    const { given, surname, hadSlash } = effectiveParts(name);
    if (isUnknownNameToken(given)) bump(tokenCounts, given!.trim());
    if (isUnknownNameToken(surname)) bump(tokenCounts, surname!.trim());
    // A *fully* blank name — both parts empty in the slash form ("//") — is the
    // deliberate counterpart to an explicit token ("NN /NN/"): an entirely
    // unknown person recorded by leaving the slots empty. That is the only
    // reliable blank-convention signal; half-known names are skipped above.
    if (hadSlash && !given && !surname) blanks++;
  }
  const token = mostFrequent(tokenCounts);
  const tokenTotal = total(tokenCounts);
  const target: UnknownNameTarget =
    tokenTotal > blanks && token ? { form: "token", token } : { form: "blank" };
  return { target, token };
}

/**
 * Rewrite unknown-name placeholders on an individual's primary `NAME` into the
 * master's convention — stripping them (`blank`) or unifying them to the master's
 * marker (`token`). The given and surname are each cleaned in *both* places they
 * can live — the slash-delimited NAME value and the `GIVN`/`SURN` sub-tag — so no
 * placeholder survives, even one shadowed by a real value (the two can drift).
 * Returns one before/after change per slot rewritten.
 */
export function reshapeUnknownNames(indi: GedNode, target: UnknownNameTarget): NormChange[] {
  const name = firstChild(indi, "NAME");
  if (!name) return [];
  const repl = target.form === "token" ? target.token ?? "" : "";

  const { given, surname, rest, hadSlash } = valueParts(name);
  const changes: NormChange[] = [];
  const g = cleanSlot(name, given, "GIVN", repl, changes);
  const s = cleanSlot(name, surname, "SURN", repl, changes);
  if (g !== given || s !== surname) writeValue(name, g, s, rest, hadSlash);
  return changes;
}

/**
 * Clean one slot's placeholder. The value slot wins when both it and the sub-tag
 * carry the same placeholder (so the redundant pair counts once); a stale
 * placeholder in the sub-tag alone is still cleaned. The sub-tag is always
 * reconciled to the cleaned value, but a *real* sub-tag is left untouched.
 * Returns the cleaned value-slot text.
 */
function cleanSlot(
  name: GedNode,
  valueText: string | undefined,
  subTag: "GIVN" | "SURN",
  repl: string,
  changes: NormChange[],
): string | undefined {
  const child = firstChild(name, subTag);
  if (isUnknownNameToken(valueText) && valueText!.trim() !== repl) {
    changes.push({ before: valueText!.trim(), after: repl || "(blank)" });
    reconcileChild(name, child, repl);
    return repl || undefined;
  }
  if (child && isUnknownNameToken(child.value) && child.value!.trim() !== repl) {
    changes.push({ before: child.value!.trim(), after: repl || "(blank)" });
    reconcileChild(name, child, repl);
  }
  return valueText;
}

/** Set an existing GIVN/SURN sub-tag to the replacement, or remove it when blank. */
function reconcileChild(name: GedNode, child: GedNode | undefined, repl: string): void {
  if (!child) return;
  if (repl) child.value = repl;
  else name.children = name.children.filter((c) => c !== child);
}

// --- name-node helpers -----------------------------------------------------

interface Parts {
  given?: string;
  surname?: string;
  /** Text after the closing slash (a suffix like "Jr"), preserved on rewrite. */
  rest?: string;
  hadSlash: boolean;
}

/** The NAME value's own slash-delimited parts (sub-tags handled separately). */
function valueParts(name: GedNode): Parts {
  const raw = (name.value ?? "").trim();
  const slash = raw.match(/^(.*?)\/([^/]*)\/(.*)$/);
  if (slash) {
    return {
      given: slash[1].trim() || undefined,
      surname: slash[2].trim() || undefined,
      rest: slash[3].trim() || undefined,
      hadSlash: true,
    };
  }
  return { given: raw || undefined, surname: undefined, hadSlash: false };
}

/** The effective parts as `parseName` sees them: value slots, then GIVN/SURN. */
function effectiveParts(name: GedNode): Parts {
  const v = valueParts(name);
  const givn = firstChild(name, "GIVN")?.value?.trim();
  const surn = firstChild(name, "SURN")?.value?.trim();
  return { given: v.given ?? givn, surname: v.surname ?? surn, hadSlash: v.hadSlash };
}

/** Write the cleaned given/surname back into the NAME value's slash form. */
function writeValue(name: GedNode, given: string | undefined, surname: string | undefined, rest: string | undefined, hadSlash: boolean): void {
  const needsSlash = hadSlash || !!surname;
  const surPart = needsSlash ? `/${surname ?? ""}/` : "";
  name.value = [given ?? "", surPart, rest ?? ""].map((p) => p.trim()).filter(Boolean).join(" ");
}

// --- counting helpers ------------------------------------------------------

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}
function total(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}
function mostFrequent(m: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [k, c] of m) if (c > bestCount) { best = k; bestCount = c; }
  return best;
}
