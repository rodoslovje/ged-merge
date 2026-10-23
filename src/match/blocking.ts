import { birthYear } from "../gedcom/lifespan";
import type { Dataset, Individual } from "../gedcom/types";
import { eraYear, estimatedBirthYear } from "./birthEstimate";
import { givenVariantKey } from "./givenVariants";
import { ownComparableName } from "./similarity";
import { foldToken, soundex } from "./text";

/**
 * Cross-file blocking (`matchDatasets`): which main records an incoming record
 * is compared with at all. See MATCHING.md § Blocking.
 *
 * The keys are **asymmetric** — a main record is indexed under its own bucket
 * only and the incoming record looks up the neighbouring ones — so a key's
 * reach is set in one place, and a main record met under several of the
 * incoming record's keys is visited once per bucket rather than once per
 * overlapping window.
 *
 * - **surname + birth decade** (`B:`): the main record under its birth decade
 *   (an estimated year, being rougher, also under the decades either side);
 *   the incoming record looks up its decade ±2 (±3 for an estimate). The reach
 *   is the one the symmetric ±1/±2 keys had: two decades between two recorded
 *   births, a decade more for each estimate. Records with no birth year at all
 *   meet under `U:` (surname alone).
 * - **surname + given initial + era** (`G:`), bounded by the era gate itself:
 *   the main record sits in the {@link ERA_BLOCK}-year block holding its era
 *   year (`eraYear`, the year the gate reads), and the incoming record looks
 *   up every block that can hold a year within `maxYearGap` of its own. Every
 *   same-initial pair the gate would let through is still reached — the key
 *   used to have no era at all and reached across centuries only for the gate
 *   to refuse it. A record with no era year meets every block of its name
 *   (`GA:`), and a dated one meets the undated ones (`GU:`).
 *
 * A **crowded `B:` bucket** (more than {@link BUCKET_CAP} main records — a
 * parish's commonest surname in one decade) is not walked whole: the incoming
 * record looks up its `BX:` sub-buckets instead, which also require one
 * given-name token to agree in key — its cross-language equivalence group,
 * else its soundex digits — so `Katarina`/`Catharina`, `Neža`/`Agnes` and the
 * `Maria` of `Anna Maria` still meet, while `Marija` and `Antonija` of one
 * decade's thousand Novaks no longer do. A main record with no given name is
 * reachable there under `BX:…:-`.
 *
 * A record whose name is all placeholders gets no key (see
 * `individualBlockKeys`, the within-file twin, which stays symmetric).
 */

/** Width in years of an era block of the `G:` key. */
const ERA_BLOCK = 5;

/**
 * Main records in one surname + decade bucket beyond which an incoming record
 * looks up the given-name sub-buckets instead of walking it whole. Small
 * enough that a crowded name stops costing quadratically (Hawlina's largest
 * bucket holds 662), large enough that a family-sized bucket — where a
 * different-spelling given name is likeliest to be the same person — is still
 * walked whole.
 */
export const BUCKET_CAP = 32;

interface Parts {
  sdx: string;
  /** First letter of the folded given name (the `G:` key). */
  initial?: string;
  /** Per-token given-name keys (the `BX:` sub-buckets). */
  givenKeys: string[];
  decade?: number;
  estimated: boolean;
  era?: number;
}

const partsCache = new WeakMap<Individual, Parts | null>();

function blockParts(indi: Individual, ds: Dataset): Parts | undefined {
  const cached = partsCache.get(indi);
  if (cached !== undefined) return cached ?? undefined;
  const n = ownComparableName(indi);
  const given = n?.given;
  const sdx = soundex(n?.surname ?? given ?? "");
  if (!sdx) {
    partsCache.set(indi, null);
    return undefined;
  }
  const realYear = birthYear(indi);
  const year = realYear ?? estimatedBirthYear(indi, ds);
  const folded = given ? foldToken(given) : "";
  const parts: Parts = {
    sdx,
    initial: given ? (folded[0] ?? "") : undefined,
    givenKeys: givenTokenKeys(folded),
    decade: year !== undefined ? Math.floor(year / 10) : undefined,
    estimated: realYear === undefined,
    era: eraYear(indi, ds),
  };
  partsCache.set(indi, parts);
  return parts;
}

/** One key per given-name token: its equivalence group in the variant table,
 *  else its soundex digits (the first letter dropped, so `K`atarina and
 *  `C`atharina agree). `-` for a record with no given name. */
function givenTokenKeys(folded: string): string[] {
  const keys = new Set<string>();
  for (const token of folded.split(/[\s-]+/)) {
    if (!token) continue;
    const group = givenVariantKey(token);
    if (group !== undefined) keys.add(`v${group}`);
    else {
      const code = soundex(token);
      if (code) keys.add(code.slice(1));
    }
  }
  return keys.size ? [...keys] : ["-"];
}

/** The main file's records, bucketed for the incoming records' look-ups. */
export class CrossBlockIndex {
  private readonly buckets = new Map<string, number[]>();
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(
    /** The main file's records; a candidate is reported as its position here. */
    readonly records: readonly Individual[],
    ds: Dataset,
    /** The era gate's `maxYearGap`. */
    private readonly gap: number,
  ) {
    this.seen = new Uint32Array(records.length);
    const add = (key: string, i: number) => {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    };
    records.forEach((indi, i) => {
      const p = blockParts(indi, ds);
      if (!p) return;
      if (p.decade !== undefined) {
        for (const d of mainDecades(p)) add(`B:${p.sdx}:${d}`, i);
      } else {
        add(`U:${p.sdx}`, i);
      }
      if (p.initial !== undefined) {
        const g = `${p.sdx}:${p.initial}`;
        add(p.era !== undefined ? `G:${g}:${Math.floor(p.era / ERA_BLOCK)}` : `GU:${g}`, i);
        add(`GA:${g}`, i);
      }
    });
    // The given-name sub-buckets, only where a decade bucket is crowded.
    records.forEach((indi, i) => {
      const p = blockParts(indi, ds);
      if (p?.decade === undefined) return;
      for (const d of mainDecades(p)) {
        if (!this.crowded(`B:${p.sdx}:${d}`)) continue;
        for (const g of p.givenKeys) add(`BX:${p.sdx}:${d}:${g}`, i);
      }
    });
  }

  private crowded(key: string): boolean {
    return (this.buckets.get(key)?.length ?? 0) > BUCKET_CAP;
  }

  /** Call `visit` once for every main record (by position) the incoming
   *  record shares a bucket with. */
  forEachCandidate(indi: Individual, ds: Dataset, visit: (mainIndex: number) => void): void {
    const p = blockParts(indi, ds);
    if (!p) return;
    const stamp = ++this.stamp;
    const walk = (key: string) => {
      const bucket = this.buckets.get(key);
      if (!bucket) return;
      for (const i of bucket) {
        if (this.seen[i] === stamp) continue;
        this.seen[i] = stamp;
        visit(i);
      }
    };
    if (p.decade !== undefined) {
      const spread = p.estimated ? 3 : 2;
      for (let d = p.decade - spread; d <= p.decade + spread; d++) {
        const key = `B:${p.sdx}:${d}`;
        if (!this.crowded(key)) walk(key);
        else {
          walk(`BX:${p.sdx}:${d}:-`);
          for (const g of p.givenKeys) if (g !== "-") walk(`BX:${p.sdx}:${d}:${g}`);
        }
      }
    } else {
      walk(`U:${p.sdx}`);
    }
    if (p.initial !== undefined) {
      const g = `${p.sdx}:${p.initial}`;
      if (p.era !== undefined) {
        // Every block that can hold a year within `gap` of this one.
        const lo = Math.floor((p.era - this.gap) / ERA_BLOCK);
        const hi = Math.floor((p.era + this.gap) / ERA_BLOCK);
        for (let b = lo; b <= hi; b++) walk(`G:${g}:${b}`);
        walk(`GU:${g}`);
      } else {
        walk(`GA:${g}`);
      }
    }
  }
}

/** The decades a main record is indexed under: its own, and for an estimated
 *  year — rougher than a recorded one — the decades either side. */
function mainDecades(p: Parts): number[] {
  const d = p.decade!;
  return p.estimated ? [d - 1, d, d + 1] : [d];
}
