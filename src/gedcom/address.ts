import type { GedEvent, GedNode } from "./types";

/**
 * GEDCOM's address structure, as it hangs under an event (and a repository):
 *
 *     2 ADDR Dunajska 5          ← the address as one free-text line (+ CONT)
 *     3 ADR1 Dunajska 5          ← the same, cut into labelled lines
 *     3 CITY Ljubljana
 *     3 POST 1000
 *     3 CTRY Slovenija
 *     2 PHON +386 1 234 5678     ← contact lines, siblings of ADDR
 *     2 EMAIL ...
 *
 * Both dialects share it (7.0 keeps ADR1–ADR3 as deprecated but valid). Many
 * files write only the line; some programs write only the labelled lines and
 * leave the ADDR value empty. Either way the address is the house, not the
 * settlement — the PLAC beside it says that.
 */

/** The labelled lines under an ADDR, in the order the standard lists them. */
export const ADDRESS_PART_TAGS = ["ADR1", "ADR2", "ADR3", "CITY", "STAE", "POST", "CTRY"] as const;
export type AddressPartTag = (typeof ADDRESS_PART_TAGS)[number];

/** The contact lines that stand beside an ADDR, in the standard's order.
 *  (`WWW` belongs here too, but the app treats an event's WWW as a link.) */
export const ADDRESS_CONTACT_TAGS = ["PHON", "EMAIL", "FAX"] as const;
export type AddressContactTag = (typeof ADDRESS_CONTACT_TAGS)[number];

/** An ADDR's labelled lines, by tag — only the ones it carries. */
export type AddressParts = Partial<Record<AddressPartTag, string>>;

/** The lines a structured address's text is joined from, when the ADDR has no
 *  text of its own: the street lines, the town and the postcode. The region
 *  and the country say where the settlement is, which the place already does. */
const ADDRESS_TEXT_TAGS: readonly AddressPartTag[] = ["ADR1", "ADR2", "ADR3", "CITY", "POST"];

/** The labelled lines an ADDR node carries, or undefined when it has none. */
export function readAddressParts(addr: GedNode | undefined): AddressParts | undefined {
  if (!addr) return undefined;
  let out: AddressParts | undefined;
  for (const c of addr.children) {
    const tag = c.tag as AddressPartTag;
    const v = c.value?.trim();
    if (v && (ADDRESS_PART_TAGS as readonly string[]).includes(tag) && !out?.[tag]) (out ??= {})[tag] = v;
  }
  return out;
}

/** An ADDR as one string ("" when it says nothing): its own text, or — for an
 *  ADDR that carries only its labelled lines — those joined. */
export function addressText(addr: GedNode | undefined): string {
  if (!addr) return "";
  const own = addr.value?.trim();
  if (own) return own;
  return addr.children
    .filter((c) => (ADDRESS_TEXT_TAGS as readonly string[]).includes(c.tag) && c.value?.trim())
    .map((c) => c.value!.trim())
    .join(", ");
}

/** Whether an event carries any of the address structure beyond its line:
 *  labelled lines, or contact lines beside it. */
export function eventHasAddressStructure(ev: GedEvent | undefined): boolean {
  return !!ev?.addressParts || !!ev?.phone || !!ev?.email || !!ev?.fax;
}

/**
 * An event's whole address as one comparable string — the line, the labelled
 * lines the line does not already say, and the contact lines — for a review
 * that must tell two addresses apart by more than their first line. Equal to
 * the plain `address` text for an event with no structure.
 */
export function eventAddressFullText(ev: GedEvent | undefined, base = ev?.address?.raw): string | undefined {
  if (!ev || !eventHasAddressStructure(ev)) return base;
  const pieces = [
    ev.addressParts ? ev.addressLine : base,
    ...ADDRESS_PART_TAGS.map((tag) => ev.addressParts?.[tag]),
    ev.phone,
    ev.email,
    ev.fax,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pieces) {
    const v = p?.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join(", ") || undefined;
}

/** The tag a contact line goes by in a file — `EMAI` is a common misspelling
 *  of `EMAIL`, read as it. */
export function contactTagOf(tag: string): AddressContactTag | undefined {
  if (tag === "EMAI") return "EMAIL";
  return (ADDRESS_CONTACT_TAGS as readonly string[]).includes(tag) ? (tag as AddressContactTag) : undefined;
}
