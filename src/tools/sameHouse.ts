import { addressStreetName, bracketedTail, decomposePlace, placeCollator } from "../gedcom/place";
import { sameStreet } from "../geo/addressRegister";
import { abbreviates, splitAddressVariants } from "../geo/rn";
import { foldToken } from "../match/text";
import type { AddressRow } from "./addresses";

// One house the file writes two ways.
//
// A row is keyed on the exact place+address text, so every extra character
// makes a second house: "Breg ob Savi 26" and "Breg ob Savi 26 (pd Mlinar)" sit
// on two lines carrying ten events and two, and neither line says the other is
// the same door. That is not a register question — no register has an opinion
// about the researcher's own annotations — it is the file disagreeing with
// itself, which is why it is answered here, on the list where the houses are,
// rather than in the compliance check.
//
// Only ever within one place. "Loka 4" in two villages is two houses, and the
// whole reason the addresses list groups by place is that a house number means
// nothing without the settlement around it.

/** Why two rows are one house — what the row says, and what the join writes. */
export type SameHouseKind =
  /** One is the other plus the researcher's own note: "26" ⊂ "26 (pd Mlinar)". */
  | "note"
  /** One names fewer of the house's names: "Labore 4" ⊂ "Labore 4 / Škofjeloška 4". */
  | "variant"
  /** The same house number on the same street, spelt more fully or in another
   *  case: "Kidričeva 38" against "Kidričeva cesta 38", "breg" against "Breg". */
  | "spelling";

/** The fuller row this one would join. */
export interface SameHouse {
  /** {@link AddressRow.key} of the fuller row. */
  into: string;
  /** Its address — what the join writes onto this row's events. */
  address: string;
  kind: SameHouseKind;
}

/** One row reduced to what deciding "same house" needs. */
interface Reading {
  row: AddressRow;
  /** The house's names, folded, each with its bracketed note taken off — one
   *  entry per whole address the value lists. */
  parts: Set<string>;
  /** The house numbers those names hang off, folded. */
  numbers: string[];
  /** The researcher's bracketed note, folded ("" when there is none). */
  note: string;
  /** The name the number hangs off, when the value names exactly one house. */
  street: string;
}

function read(row: AddressRow): Reading {
  const parts = new Set<string>();
  const numbers: string[] = [];
  let street = "";
  const variants = splitAddressVariants(row.address);
  for (const variant of variants) {
    const bare = variant.replace(bracketedTail(variant), "").trim();
    if (bare) parts.add(foldToken(bare));
    const number = decomposePlace(bare).houseNumber;
    if (number) numbers.push(foldToken(number));
    if (variants.length === 1) street = addressStreetName(bare) ?? "";
  }
  return { row, parts, numbers, note: foldToken(bracketedTail(row.address)), street };
}

/** Whether every one of `a`'s names is among `b`'s. */
function within(a: Set<string>, b: Set<string>): boolean {
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

/**
 * How rich a reading is — the order the comparison runs in, so a row only ever
 * joins one already judged fuller than itself and no two rows can point at each
 * other. More names first, then one carrying a note, then the longer text, and
 * for two spellings of equal weight the one the file uses more often: joining
 * five events into one is the correction, not the other way round.
 */
function richer(a: Reading, b: Reading): number {
  return (
    b.parts.size - a.parts.size ||
    (b.note ? 1 : 0) - (a.note ? 1 : 0) ||
    b.row.address.length - a.row.address.length ||
    b.row.count - a.row.count ||
    placeCollator.compare(a.row.address, b.row.address)
  );
}

/** Whether `lean` is the same house as the fuller `full`, and on what grounds. */
function sameHouseKind(lean: Reading, full: Reading): SameHouseKind | undefined {
  if (!lean.parts.size || !full.parts.size) return undefined;
  const sameNames = lean.parts.size === full.parts.size && within(lean.parts, full.parts);

  // The same names, and one of them carries a note the other does not.
  if (sameNames && !lean.note && full.note) return "note";
  // Two different notes on one house — "(pd Mlinar)" against "(mlin)" — is a
  // question about what the house was called, not a spelling to sweep up.
  if (sameNames && lean.note && full.note && lean.note !== full.note) return undefined;
  // The same names spelt the same way: what differs is case or spacing alone.
  if (sameNames && lean.note === full.note) return "spelling";

  // Fewer names: the file recorded this house under both the street it had and
  // the one it has, and this row names only one of them. Its own note may ride
  // along — as long as it is not a *different* note, which the guard above has
  // already turned away.
  if (within(lean.parts, full.parts) && (!lean.note || lean.note === full.note)) return "variant";

  // One name each, one number, one street written at two lengths.
  if (lean.parts.size === 1 && full.parts.size === 1 && lean.note === full.note) {
    const number = lean.numbers[0];
    if (!number || number !== full.numbers[0]) return undefined;
    if (!lean.street || !full.street) return undefined;
    if (foldToken(lean.street) === foldToken(full.street)) return undefined;
    // Either the register's own test for one street written short, or the
    // settlement test for a village named short — "Breg 2" under Breg ob Savi.
    if (sameStreet(lean.street, full.street) || abbreviates(lean.street, full.street)) return "spelling";
  }
  return undefined;
}

/**
 * Every row that is another row's house, keyed by the row that would move.
 *
 * Rows are compared only against rows sharing one of their house numbers, and
 * only within their own place, so a village of a thousand houses costs a pass
 * and not a square. A row absent from the map is a house of its own.
 */
export function findSameHouse(rows: readonly AddressRow[]): Map<string, SameHouse> {
  const byPlace = new Map<string, Reading[]>();
  for (const row of rows) {
    if (!row.address.trim()) continue;
    const list = byPlace.get(row.place);
    if (list) list.push(read(row));
    else byPlace.set(row.place, [read(row)]);
  }

  /** Row key → the row it joins, before chains are followed through. */
  const step = new Map<string, { into: string; address: string; kind: SameHouseKind }>();
  for (const readings of byPlace.values()) {
    if (readings.length < 2) continue;
    readings.sort(richer);
    // Which readings share a house number, so each row is held against the few
    // that could possibly be it rather than against the whole village.
    const byNumber = new Map<string, Reading[]>();
    for (const r of readings) {
      for (const n of r.numbers.length ? r.numbers : [""]) {
        const bucket = byNumber.get(n);
        if (bucket) bucket.push(r);
        else byNumber.set(n, [r]);
      }
    }
    const rank = new Map<Reading, number>(readings.map((r, i) => [r, i]));
    for (const lean of readings) {
      let best: { full: Reading; kind: SameHouseKind } | undefined;
      for (const n of lean.numbers.length ? lean.numbers : [""]) {
        for (const full of byNumber.get(n) ?? []) {
          // Only ever into a richer row — that is what makes this a direction
          // and not a cycle.
          if (rank.get(full)! >= rank.get(lean)!) continue;
          if (best && rank.get(full)! >= rank.get(best.full)!) continue;
          const kind = sameHouseKind(lean, full);
          if (kind) best = { full, kind };
        }
      }
      if (best) step.set(lean.row.key, { into: best.full.row.key, address: best.full.row.address, kind: best.kind });
    }
  }

  // A joins B and B joins C: A's answer is C, the house as the file writes it
  // most fully. The walk is bounded by the map's own size, which no chain can
  // exceed without repeating a row.
  const out = new Map<string, SameHouse>();
  for (const [key, first] of step) {
    let target = first;
    for (let i = 0; i < step.size; i++) {
      const next = step.get(target.into);
      if (!next) break;
      target = { into: next.into, address: next.address, kind: first.kind };
    }
    if (target.into !== key) out.set(key, { into: target.into, address: target.address, kind: first.kind });
  }
  return out;
}
