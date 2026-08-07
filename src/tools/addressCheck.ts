import { addressStreetName } from "../gedcom/place";
import type { AddressHit } from "../geo/addressRegister";
import { foldToken } from "../match/text";
import type { GeocodeDecision } from "../persist/geoDb";
import type { AddressRow } from "./addresses";
import { replaceLocality } from "./addresses";

// The compliance check's second half: hold the file's *houses* against a stored
// address register, the way registerCheck.ts holds its places against a
// gazetteer.
//
// Only a downloaded register can be asked. That is not a limitation but the
// design: a whole file's worth of house numbers is thousands of lookups, which
// no public service should be asked for and which this check would have had to
// meter for minutes. Against a register in this browser it is a few IndexedDB
// reads, so the check is instant — and a country whose register is not
// downloaded is simply not checked, and says so.
//
// Deliberately a *report*, exactly like the places half: a register describes
// the country as it is today, and house numbering was redone wholesale in most
// villages of both countries during the twentieth century. That is why a number
// the register does not have is NOT reported as a disagreement by default: for
// a file of parish records it is the ordinary condition, not a fault, and
// listed with the rest it would bury the findings that mean something. It is
// counted, and shown on request.

/**
 * What a written address and the register disagree about, worst first.
 *
 * - `addrElsewhere` the register files this house under a different settlement
 *   than the place names — the file has the house under its neighbour, which is
 *   also the one finding here that moves events rather than rewords them
 * - `addrSpelling` the register writes the street differently ("Kidričeva" for
 *   its "Kidričeva cesta", "Ul. Senjsko" for its "Senjsko")
 * - `addrMissing` the register has no such number in this settlement — off the
 *   list by default; see the note above
 */
export type AddressVerdict = "addrElsewhere" | "addrSpelling" | "addrMissing";

export const ADDRESS_VERDICTS: AddressVerdict[] = ["addrElsewhere", "addrSpelling", "addrMissing"];

/** The verdict kept off the default list — counted, and shown on request. */
export const ADDRESS_ASIDE: AddressVerdict = "addrMissing";

/** Where an address dismissal is remembered. Its own prefix, so dismissing a
 *  house says nothing about the place it sits in — the two are different
 *  judgements about different values. */
export function addressDecisionKey(key: string): string {
  return `registerAddr:${key}`;
}

/** One written address the register disagrees with. */
export interface AddressFinding {
  /** The row's key ({@link AddressRow.key}) — the dismissal's key. */
  key: string;
  /** The raw place+address spellings the row covers, for a rename. */
  rawKeys: string[];
  verdict: AddressVerdict;
  /** The place the row sits under, as the file writes it. */
  place: string;
  /** The address as the file writes it. */
  written: string;
  /** Events carrying it, and everyone they belong to. */
  count: number;
  people: string[];
  /** The register's own line for this house — what a rename would write
   *  (`addrSpelling`), or simply what it holds (`addrElsewhere`). */
  official?: string;
  /** The address alone, as the register spells it — what `addrSpelling`
   *  writes onto the `ADDR` line. */
  officialAddress?: string;
  /** The settlement the register files the house under (`addrElsewhere`). */
  settlement?: string;
  /** The place value with that settlement swapped in, when the file's layout
   *  allows it to be composed (`addrElsewhere`). */
  officialPlace?: string;
  dismissed: boolean;
}

export interface AddressCheckReport {
  /** Every disagreement, dismissed ones included, worst verdict first. */
  findings: AddressFinding[];
  /** Addresses held against a register (findings included). */
  checked: number;
  /** Of those, the ones the register agrees with. */
  ok: number;
  /** Left out: no register stored for their country, or no house number to ask
   *  about at all. */
  skipped: number;
}

const RANK: Record<AddressVerdict, number> = { addrElsewhere: 0, addrSpelling: 1, addrMissing: 2 };

/**
 * Hold each address against what the register answered for it.
 *
 * `answers` is what the caller resolved — one entry per row it *asked* about,
 * so a row absent from it was never asked (no register for its country) and is
 * skipped rather than judged. A row answered with several houses is skipped
 * too: the register could not tell which house is meant, and that is a question
 * for the Addresses tab to put to the researcher, not a disagreement to report.
 */
export function checkAddressesAgainstRegister(
  rows: readonly AddressRow[],
  answers: ReadonlyMap<string, readonly AddressHit[]>,
  decisions: ReadonlyMap<string, GeocodeDecision>,
): AddressCheckReport {
  const findings: AddressFinding[] = [];
  let checked = 0;
  let ok = 0;
  let skipped = 0;

  for (const row of rows) {
    const hits = answers.get(row.key);
    if (!hits) {
      skipped++;
      continue;
    }
    checked++;

    const add = (verdict: AddressVerdict, extra: Partial<AddressFinding>) =>
      findings.push({
        key: row.key,
        rawKeys: row.rawKeys,
        verdict,
        place: row.place,
        written: row.address,
        count: row.count,
        people: row.people,
        dismissed: decisions.get(addressDecisionKey(row.key))?.status === "historic",
        ...extra,
      });

    if (!hits.length) {
      add("addrMissing", {});
      continue;
    }
    // Several houses answer this number and nothing here can choose between
    // them — the Addresses tab offers the choice; this is not a disagreement.
    if (hits.length > 1) {
      ok++;
      continue;
    }
    const hit = hits[0];

    // The settlement the row claims — the place's own, as the query was built
    // from it. A register that files the house elsewhere is the strongest
    // finding here: the events belong to another village.
    const claimed = row.queries[0]?.settlement;
    if (claimed && hit.settlement && foldToken(claimed) !== foldToken(hit.settlement)) {
      const officialPlace = replaceLocality(row.place, hit.settlement);
      add("addrElsewhere", {
        official: hit.label,
        settlement: hit.settlement,
        ...(officialPlace ? { officialPlace } : {}),
      });
      continue;
    }

    // Only a file that names a street of its own can spell one differently. A
    // value carrying just a number ("38/a") is not misspelt — it is a different
    // shape, and rewriting it whole is the Addresses tab's business, not a
    // compliance finding.
    const street = addressStreetName(row.address);
    if (street && hit.street && foldToken(street) !== foldToken(hit.street)) {
      add("addrSpelling", { official: hit.label, officialAddress: hit.address });
      continue;
    }
    ok++;
  }

  findings.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      RANK[a.verdict] - RANK[b.verdict] ||
      b.count - a.count ||
      a.key.localeCompare(b.key),
  );
  return { findings, checked, ok, skipped };
}
