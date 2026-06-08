import { decomposePlace } from "../gedcom/place";
import type { PlaceLayout } from "../normalize/types";

/** How the master wants places written, so incoming places can match it. */
export interface PlaceTargetFormat {
  layout: PlaceLayout;
  /** PLAC jurisdiction-part separator, e.g. "," (Renko) or ", ". */
  separator: string;
}

/** A place reshaped into the master's layout: the parts to write back. */
export interface ReformattedPlace {
  plac?: string;
  addr?: string;
  /** Leftover detail (parish, facility) that the master layout has no slot for. */
  note?: string;
}

/**
 * Reshape an incoming event's place into the master's layout.
 *
 * For a `structured-addr` master (jurisdiction in PLAC, house number in ADDR):
 * the jurisdiction hierarchy becomes a comma-separated PLAC, the house
 * number/street becomes an ADDR, and anything that doesn't fit — parish,
 * facility — is returned as NOTE text so it is preserved rather than dropped.
 * Both the incoming PLAC and ADDR are consumed together.
 *
 * Any other target layout is a pass-through (no reshaping yet).
 */
export function reformatPlace(
  placRaw: string | undefined,
  addrRaw: string | undefined,
  fmt: PlaceTargetFormat,
): ReformattedPlace {
  if (fmt.layout !== "structured-addr") {
    return { plac: clean(placRaw), addr: clean(addrRaw) };
  }

  const p = placRaw ? decomposePlace(placRaw) : undefined;
  const a = addrRaw ? decomposePlace(addrRaw) : undefined;

  const jurisdiction = p?.jurisdiction.length ? p.jurisdiction : a?.locality ? [a.locality] : [];
  const locality = p?.locality ?? a?.locality;
  const houseNumber = a?.houseNumber ?? p?.houseNumber;
  const houseName = a?.houseName ?? p?.houseName;
  const street = p?.street ?? a?.street;
  const parish = p?.parish ?? a?.parish;
  const facility = p?.facility ?? a?.facility;

  const out: ReformattedPlace = {};
  if (jurisdiction.length) out.plac = jurisdiction.join(fmt.separator);

  let addr: string | undefined;
  if (street) addr = street;
  else if (houseNumber) addr = locality ? `${locality} ${houseNumber}` : houseNumber;
  else if (a) addr = a.raw; // an ADDR we couldn't structure further — keep it
  if (addr && houseName) addr += ` (pd ${houseName})`;
  out.addr = addr;

  const notes: string[] = [];
  if (parish) notes.push(`župnija ${parish}`);
  if (facility) notes.push(facility);
  if (notes.length) out.note = notes.join("; ");

  return out;
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};
