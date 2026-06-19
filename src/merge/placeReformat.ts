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

/** Whether a master layout triggers reshaping (others are copied verbatim). */
export function reshapesLayout(layout: PlaceLayout): boolean {
  return layout === "structured-addr" || layout === "packed-plac";
}

/**
 * Reshape an incoming event's place into the master's layout, consuming both the
 * incoming PLAC and ADDR.
 *
 *  - `structured-addr`: jurisdiction → comma-separated PLAC, house number/street
 *    → ADDR, and parish/facility that don't fit → NOTE (preserved, not dropped).
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
  const country = p?.country ?? a?.country;
  const houseNumber = a?.houseNumber ?? p?.houseNumber;
  const houseName = a?.houseName ?? p?.houseName;
  const street = p?.street ?? a?.street;
  const parish = p?.parish ?? a?.parish;
  const facility = p?.facility ?? a?.facility;

  // The address detail: a street, or "locality houseNumber", plus any house name.
  let address: string | undefined;
  if (street) address = street;
  else if (houseNumber) address = locality ? `${locality} ${houseNumber}` : houseNumber;
  else if (a && fmt.layout === "structured-addr") address = a.raw; // keep an opaque ADDR
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
  if (jurisdiction.length) out.plac = jurisdiction.join(fmt.separator);
  let addrOut = address;
  if (facility) addrOut = addrOut ? `${addrOut} (${facility})` : facility;
  out.addr = addrOut;
  if (parish) out.note = `župnija ${parish}`;
  return out;
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};
