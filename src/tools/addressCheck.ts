import { addressStreetName, bracketedTail } from "../gedcom/place";
import type { GeoCoord } from "../gedcom/types";
import { sameStreet, type AddressHit } from "../geo/addressRegister";
import { abbreviates } from "../geo/rn";
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
 * - `addrMissing` the register has no such house as the file writes it — off the
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
  /** Exactly what `addrSpelling` writes onto the `ADDR` line: the register's own
   *  spelling of the address, carrying over any bracketed note the written value
   *  ends with ("Kidričeva 38/a (porodnišnica)" → "Kidričeva cesta 38/a
   *  (porodnišnica)"). The note is the researcher's, not the register's, and a
   *  rewrite that dropped it would lose what only the file knows. */
  officialAddress?: string;
  /** The settlement the register files the house under (`addrElsewhere`). */
  settlement?: string;
  /** Where the register puts this house. Carried so the row can draw it: a
   *  finding that the register files a house under another settlement is only
   *  really answered by seeing where the house stands. */
  coord?: GeoCoord;
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
 * Whether a register answer is about the house the file writes, rather than
 * merely a house of that number.
 *
 * A lookup widens until it finds something — past the street, past the
 * settlement, out to "any house in the village carrying this number" (see
 * searchBucket and searchLocalAddress). That is right where the answer is a
 * *candidate*: the Addresses tab offers it and the researcher decides. It is
 * ruinous as a *verdict*, because a wide answer shares nothing with the written
 * address but its digits — and the check would then report the file's "Stražišče
 * 109" as a misspelling of Kranj's Jezerska cesta 109, or "Klošter 52" as really
 * belonging to Cankarjeva cesta in Metlika. Both are simply houses numbered 52
 * and 109 in a large municipality, and the register recognized nothing the
 * researcher wrote.
 *
 * So a finding needs the register's own words to agree with the file's: the
 * street it names is the street written ("Kidričeva cesta" for "Kidričeva"), or
 * the settlement it files the house under is the name the number hangs off
 * ("Dupeljne 11" written under Brdo pri Lukovici — village numbering, and the
 * real `addrElsewhere`). An address that names nothing but a number can only be
 * anchored by the settlement its place claims.
 *
 * Anything else is `addrMissing`: the register has no such house as written,
 * which is the honest reading and stays off the default list.
 */
function anchored(hit: AddressHit, host: string | undefined, claimed: string | undefined): boolean {
  if (host) return sameStreet(host, hit.street) || abbreviates(host, hit.settlement);
  return !claimed || !hit.settlement || foldToken(claimed) === foldToken(hit.settlement);
}

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

    // The name the file hangs the number off — a town street, or the village in
    // village numbering. Also what decides whether the answer is about this
    // house at all.
    const street = addressStreetName(row.address);
    // The settlement the row claims — the place's own, as the query was built
    // from it.
    const claimed = row.queries[0]?.settlement;
    if (!anchored(hit, street, claimed)) {
      add("addrMissing", {});
      continue;
    }

    // A register that files the house elsewhere is the strongest finding here:
    // the events belong to another village.
    if (claimed && hit.settlement && foldToken(claimed) !== foldToken(hit.settlement)) {
      const officialPlace = replaceLocality(row.place, hit.settlement);
      add("addrElsewhere", {
        official: hit.label,
        settlement: hit.settlement,
        coord: hit.coord,
        ...(officialPlace ? { officialPlace } : {}),
      });
      continue;
    }

    // Only a file that names a street of its own can spell one differently. A
    // value carrying just a number ("38/a") is not misspelt — it is a different
    // shape, and rewriting it whole is the Addresses tab's business, not a
    // compliance finding.
    if (street && hit.street && foldToken(street) !== foldToken(hit.street)) {
      add("addrSpelling", {
        official: hit.label,
        officialAddress: `${hit.address}${bracketedTail(row.address)}`,
        coord: hit.coord,
      });
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
