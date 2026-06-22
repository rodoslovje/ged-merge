import { decomposePlace } from "../gedcom/place";
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

  const jurisdiction = p?.jurisdiction.length ? p.jurisdiction : a?.locality ? [a.locality] : [];
  const locality = p?.locality ?? a?.locality;
  const country = normalizeCountry(p?.country ?? a?.country, fmt);
  const houseNumber = a?.houseNumber ?? p?.houseNumber;
  const houseName = a?.houseName ?? p?.houseName;
  const street = p?.street ?? a?.street;
  const parish = p?.parish ?? a?.parish;
  const facility = p?.facility ?? a?.facility;

  // The address detail: a street, or "locality houseNumber", plus any house name.
  // When the house number came from ADDR and ADDR has a different locality than
  // PLAC (e.g. ADDR="Gorenja Sava 20", PLAC="Kranj,..."), use the ADDR's own
  // locality as the prefix so we don't produce "Kranj 20" instead of "Gorenja Sava 20".
  let address: string | undefined;
  if (street) address = street;
  else if (houseNumber) {
    const fromAddr = !!a?.houseNumber;
    const prefix = (fromAddr && a?.locality && a.locality !== locality) ? a.locality : locality;
    address = prefix ? `${prefix} ${houseNumber}` : houseNumber;
  } else if (a && fmt.layout === "structured-addr") address = a.raw; // keep an opaque ADDR
  if (address && houseName) address += ` (pd ${houseName})`;

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
