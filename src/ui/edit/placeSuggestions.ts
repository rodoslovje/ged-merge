import type { Dataset } from "../../gedcom/types";

export interface PlaceSuggestions {
  placeSuggestions: string[];
  /** Canonical place key → sorted unique address strings seen at that place. */
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
}

export function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Collect all unique PLAC and ADDR values from a dataset and build canonical
 * maps (most-frequent casing wins) for normalize-on-blur. */
export function buildPlaceSuggestions(dataset: Dataset): PlaceSuggestions {
  const placeForms = new Map<string, Map<string, number>>();
  const addrForms = new Map<string, Map<string, number>>();
  // placeKey → addrRaw → count
  const placeAddrForms = new Map<string, Map<string, number>>();

  function addValue(forms: Map<string, Map<string, number>>, raw: string) {
    const r = raw.trim();
    if (!r) return;
    const key = placeKey(r);
    const m = forms.get(key) ?? new Map<string, number>();
    m.set(r, (m.get(r) ?? 0) + 1);
    forms.set(key, m);
  }

  function addEventValues(placeRaw: string | undefined, addrRaw: string | undefined) {
    if (placeRaw) addValue(placeForms, placeRaw);
    if (addrRaw) addValue(addrForms, addrRaw);
    if (placeRaw && addrRaw) {
      const pk = placeKey(placeRaw);
      const ar = addrRaw.trim();
      if (ar) {
        const m = placeAddrForms.get(pk) ?? new Map<string, number>();
        m.set(ar, (m.get(ar) ?? 0) + 1);
        placeAddrForms.set(pk, m);
      }
    }
  }

  for (const indi of dataset.individuals.values()) {
    for (const ev of indi.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }
  for (const fam of dataset.families.values()) {
    for (const ev of fam.events) addEventValues(ev.place?.raw, ev.address?.raw);
  }

  function build(forms: Map<string, Map<string, number>>): { suggestions: string[]; canonical: Map<string, string> } {
    const canonical = new Map<string, string>();
    const suggestions: string[] = [];
    for (const [key, m] of forms) {
      let best = "";
      let bestCount = 0;
      for (const [form, count] of m) {
        if (count > bestCount) { best = form; bestCount = count; }
      }
      canonical.set(key, best);
      suggestions.push(best);
    }
    suggestions.sort();
    return { suggestions, canonical };
  }

  const place = build(placeForms);
  const addr = build(addrForms);

  const placeToAddrs = new Map<string, string[]>();
  for (const [pk, m] of placeAddrForms) {
    placeToAddrs.set(pk, [...m.keys()].sort());
  }

  return {
    placeSuggestions: place.suggestions,
    placeToAddrs,
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
  };
}

/** Canonical lookup: given raw user input, return the canonical casing form if
 * it matches an existing entry in the map, otherwise return the input trimmed. */
export function applyCanonical(raw: string, canonical: Map<string, string>): string {
  const key = raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
  return canonical.get(key) ?? raw.trim();
}
