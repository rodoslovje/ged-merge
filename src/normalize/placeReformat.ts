import { addressStreetName, decomposePlace, stripHouseNumber } from "../gedcom/place";
import { canonicalPlaceToken } from "../match/place";
import type { PlaceTargetFormat, ReformattedPlace } from "./types";

/** Whether a master layout triggers reshaping (others are copied verbatim). */
export function reshapesLayout(layout: PlaceTargetFormat["layout"]): boolean {
  return layout === "structured-addr" || layout === "packed-plac";
}

/**
 * Reshape an incoming event's place into the master's layout, consuming both the
 * incoming PLAC and ADDR.
 *
 *  - `structured-addr`: jurisdiction → comma-separated PLAC, house number/street
 *    → ADDR, facility that doesn't fit → ADDR parenthetical, and parish → AGNC
 *    (the parish was the record-keeping agency; preserved, not dropped).
 *  - `packed-plac`: everything is recomposed into one PLAC
 *    ("Locality (Country), Street No - župnija X (facility)"), the ADDR is folded
 *    in and dropped, and unused middle jurisdiction levels (municipality/region)
 *    are discarded.
 *
 * Any other target layout is a pass-through.
 */
export function reformatPlace(
  placRaw: string | undefined,
  addrRaw: string | undefined,
  fmt: PlaceTargetFormat,
): ReformattedPlace {
  if (!reshapesLayout(fmt.layout)) {
    return { plac: clean(placRaw), addr: clean(addrRaw) };
  }

  const p = placRaw ? decomposePlace(placRaw) : undefined;
  const a = addrRaw ? decomposePlace(addrRaw) : undefined;

  let jurisdiction = p?.jurisdiction.length ? p.jurisdiction : a?.locality ? [a.locality] : [];
  let locality = p?.locality ?? a?.locality;
  const country = normalizeCountry(p?.country ?? a?.country, fmt);
  const houseNumber = a?.houseNumber ?? p?.houseNumber;
  const houseName = a?.houseName ?? p?.houseName;
  const street = p?.street ?? a?.street;
  // The parish that needs to *move* into AGNC: only when it was written inline
  // in PLAC/ADDR text (packed layouts). A parish already in its own AGNC field
  // (structured layouts) is left there untouched by the caller.
  const parish = p?.parish ?? a?.parish;
  const facility = p?.facility ?? a?.facility;

  // Use the master's own attested PLAC/ADDR pairings (see PlaceHierarchy) to
  // recognize a more specific locality than the incoming jurisdiction names —
  // e.g. a street the master tree already ties to a particular hamlet — and to
  // fill in jurisdiction levels the incoming place omits (e.g. a municipality),
  // the way the master itself writes that locality. A parish is deliberately
  // *not* used as a hint: one parish commonly spans many villages, so the
  // most-common locality for it is an unreliable plurality, not a real clue.
  if (fmt.hierarchy) {
    // `street` (from a packed PLAC's inline "Hafnarjeva pot 21/a") still has
    // its house number attached — strip it so it matches the learned key,
    // the same number-free form inferPlaceHierarchy learned it as.
    const streetHint = street ? stripHouseNumber(street) : undefined;
    const addrStreet = addressStreetName(addrRaw);
    // A "street" that is just the locality repeated before a house number
    // ("Zgornje Bitnje 165") is not a disambiguating street — the locality is
    // already as specific as it gets. Using it as a hint would relocate the
    // record to wherever that same name happens to appear as a street under a
    // *different* locality in the master, overriding an already-correct place.
    const { localityOfStreet } = fmt.hierarchy;
    const streetLocality = (s: string | undefined): string | undefined =>
      s && s.toLowerCase() !== locality?.toLowerCase()
        ? localityOfStreet.get(s.toLowerCase())
        : undefined;
    const hinted = streetLocality(streetHint) || streetLocality(addrStreet);
    if (hinted && hinted.toLowerCase() !== locality?.toLowerCase()) {
      locality = hinted;
      jurisdiction = [hinted, ...jurisdiction.slice(1)];
    }
    const parents = locality && fmt.hierarchy.parentOf.get(locality.toLowerCase());
    if (parents && parents.length > jurisdiction.length - 1) {
      jurisdiction = [jurisdiction[0] ?? locality, ...parents];
    }
  }

  // The address detail: a street, or "locality houseNumber", plus any house name.
  // When the house number came from ADDR and ADDR has a different locality than
  // PLAC (e.g. ADDR="Gorenja Sava 20", PLAC="Kranj,..."), use the ADDR's own
  // locality as the prefix so we don't produce "Kranj 20" instead of "Gorenja Sava 20".
  let address: string | undefined;
  let opaqueAddr = false;
  if (street) address = street;
  else if (houseNumber) {
    const fromAddr = !!a?.houseNumber;
    const prefix = (fromAddr && a?.locality && a.locality !== locality) ? a.locality : locality;
    address = prefix ? `${prefix} ${houseNumber}` : houseNumber;
  } else if (a && fmt.layout === "structured-addr" && !a.facility) {
    address = a.raw; // keep an opaque ADDR verbatim — it already holds any house name
    opaqueAddr = true;
  }
  // (skip when the ADDR is purely a facility — `a.raw` already holds it and the
  //  facility branch below re-emits it, which would otherwise duplicate the text)
  if (address && houseName && !opaqueAddr) address += ` (pd ${houseName})`;

  if (fmt.layout === "packed-plac") {
    // Recompose into a single PLAC; drop unused middle jurisdiction levels.
    let plac = locality ?? jurisdiction[0] ?? "";
    if (country) plac += ` (${country})`;
    if (address) plac += `, ${address}`;
    if (parish) plac += ` - župnija ${parish}`;
    if (facility) plac += address || parish ? ` (${facility})` : `, ${facility}`;
    return { plac: plac || undefined };
  }

  // structured-addr
  const out: ReformattedPlace = {};
  if (jurisdiction.length) {
    const normJurisdiction = jurisdiction.map(p => normalizeCountry(p, fmt) ?? p);
    out.plac = normJurisdiction.join(fmt.separator);
  }
  let addrOut = address;
  if (facility) addrOut = addrOut ? `${addrOut} (${facility})` : facility;
  out.addr = addrOut;
  if (parish) out.agency = `župnija ${parish}`;
  return out;
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Return the master's preferred display form for this country token, or the original. */
function normalizeCountry(raw: string | undefined, fmt: PlaceTargetFormat): string | undefined {
  if (!raw || !fmt.countryPreferred) return raw;
  const canonical = canonicalPlaceToken(raw);
  return fmt.countryPreferred.get(canonical) ?? raw;
}
