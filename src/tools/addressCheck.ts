import { addressStreetName, bracketedTail } from "../gedcom/place";
import type { GeoCoord } from "../gedcom/types";
import { sameStreet, type AddressHit } from "../geo/addressRegister";
import { abbreviates, splitAddressVariants } from "../geo/rn";
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
 * The register's own line for a house, carrying the researcher's bracketed note.
 *
 * The note says what the house is — "(dom starejših)", "(pd Piščk)" — and no
 * register knows it. It is already kept when a spelling is taken; it has to be
 * kept when the line is merely *shown* too, or the arrow reads as though
 * accepting the finding would throw the note away.
 */
function withNote(hit: AddressHit, written: string): string {
  const tail = bracketedTail(written);
  return tail ? hit.label.replace(hit.address, `${hit.address}${tail}`) : hit.label;
}

/**
 * Whether the register's answer is about the street the file writes.
 *
 * A lookup widens until it finds something — past the settlement, and for a
 * value naming no street out to "any house in this village carrying this
 * number" (see searchBucket and searchLocalAddress). That is right where the
 * answer is a *candidate*: the Addresses tab offers it and the researcher
 * decides. It is ruinous as a *verdict*, because a wide answer shares nothing
 * with the written address but its digits. A municipality the size of Kranj has
 * a house of every number, so the check reported "Stražišče 109" as a
 * misspelling of Jezerska cesta 109, "Naklo 67" of Temniška ulica 67, and
 * "Klošter 52" as really belonging to Cankarjeva cesta in Metlika — in none of
 * which had the register recognized a single word the researcher wrote.
 *
 * Only a register street that *is* the written one, spelt more fully or more
 * briefly ("Kidričeva cesta" for "Kidričeva", "Senjsko" for "Ul. Senjsko"),
 * makes a spelling finding. Everything else is `addrMissing`.
 */
function namesTheStreet(written: string | undefined, hit: AddressHit): boolean {
  return !!written && !!hit.street && sameStreet(written, hit.street);
}

/**
 * Whether a register answer that sits in *another* settlement is nevertheless
 * about this house.
 *
 * The two honest readings, and the only two: the street matched and only the
 * settlement differs (Hafnarjeva pot written under Stražišče, which the register
 * files under Kranj), or the name the number hangs off is the register's own
 * settlement (village numbering — "Dupeljne 11" written under Brdo pri
 * Lukovici). A settlement reached by widening alone, sharing nothing with the
 * written value, moves no events anywhere.
 */
function namesTheSettlement(written: string | undefined, hit: AddressHit): boolean {
  return namesTheStreet(written, hit) || abbreviates(written, hit.settlement);
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

    // A value naming both the old and the new name of one house — "Labore 4 /
    // Škofjeloška 4", a street Kranj renamed — is two whole addresses, looked up
    // as two ({@link splitAddressVariants}), and their answers arrive in one
    // bag. Each half is judged on its own and only the half the register knows
    // is rewritten, so taking the official spelling keeps the historical name
    // the researcher deliberately recorded.
    const variants = splitAddressVariants(row.address);
    // The settlement the row claims — the place's own, as the query was built
    // from it.
    const claimed = row.queries[0]?.settlement;
    let elsewhere: { hit: AddressHit; variant: string } | undefined;
    const spelled: { hit: AddressHit; variant: string }[] = [];
    /** A half the register answered with a house that is not it. */
    let unknown = false;

    for (const variant of variants) {
      // The name the file hangs the number off — a town street, or the village
      // itself in village numbering.
      const written = addressStreetName(variant);
      // Which answers this half can claim. With one address in the value they
      // all are; with two, only the ones naming this half's street, since the
      // other half's lookup put its own houses in the same bag.
      const own = variants.length > 1 ? hits.filter((h) => namesTheStreet(written, h)) : hits;
      // Several houses answer this number and nothing here can choose between
      // them — the Addresses tab offers the choice; this is not a disagreement.
      if (own.length !== 1) {
        if (!own.length) unknown = true;
        continue;
      }
      const hit = own[0];

      // A register that files the house elsewhere is the strongest finding
      // here: the events belong to another village.
      if (claimed && hit.settlement && foldToken(claimed) !== foldToken(hit.settlement)) {
        if (namesTheSettlement(written, hit)) elsewhere ??= { hit, variant };
        else unknown = true;
        continue;
      }

      // Only a file that names a street of its own can spell one differently. A
      // value carrying just a number ("38/a") is not misspelt — it is a
      // different shape, and rewriting it whole is the Addresses tab's
      // business, not a compliance finding.
      if (written && hit.street && foldToken(written) !== foldToken(hit.street)) {
        if (namesTheStreet(written, hit)) spelled.push({ hit, variant });
        else unknown = true;
      }
    }

    if (elsewhere) {
      const { hit, variant } = elsewhere;
      const officialPlace = replaceLocality(row.place, hit.settlement);
      add("addrElsewhere", {
        official: withNote(hit, variant),
        settlement: hit.settlement,
        coord: hit.coord,
        ...(officialPlace ? { officialPlace } : {}),
      });
    } else if (spelled.length) {
      // Each rewritten half spliced back into the value as the file writes it,
      // so what the row offers is the whole ADDR line and never one half of it.
      const officialAddress = spelled.reduce(
        (value, { hit, variant }) => value.replace(variant, `${hit.address}${bracketedTail(variant)}`),
        row.address,
      );
      add("addrSpelling", {
        official: withNote(spelled[0].hit, spelled[0].variant),
        officialAddress,
        coord: spelled[0].hit.coord,
      });
    } else if (unknown) {
      add("addrMissing", {});
    } else {
      ok++;
    }
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
