import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { buildGazetteerIndex, searchGazetteer, type GazetteerIndex } from "../../geo/gazetteer";
import { searchGov } from "../../geo/gov";
import { searchNominatim } from "../../geo/nominatim";
import { rnQueriesFrom, searchAddresses } from "../../geo/rn";
import {
  placeDepthOf,
  proposalFromGazEntry,
  proposalFromGov,
  proposalFromNominatim,
  proposalFromRn,
  proposalKey,
  type PlaceProposal,
  type PlaceStyle,
} from "../../geo/placeProposal";
import { inferPlaceExportFormat } from "../../normalize/profile";
import { loadCountries } from "../../persist/geoDb";
import { useSettings } from "../SettingsContext";

// Looking a place up in the registers while editing an event — the counterpart
// to the place autocomplete's list of places the file already knows. That list
// cannot help with a village entered for the first time; the registers can, and
// they know the whole chain (občina, country), the house address and the
// coordinate, so one pick fills in what would otherwise be typed by hand.
//
// Supplied here rather than through the event rows: place fields sit several
// components deep on both the individual and the family side, the same way the
// coordinate share does (see CoordShareContext).

export interface PlaceLookup {
  /** Registers matching the typed text, already written in the file's layout. */
  search: (query: string) => Promise<PlaceProposal[]>;
  /** Whether the online registers may be queried at all (Settings → online
   *  lookups). When off, only an imported gazetteer answers — and the panel
   *  says so instead of silently returning less. */
  online: boolean;
}

const PlaceLookupContext = createContext<PlaceLookup | null>(null);

export const PlaceLookupProvider = PlaceLookupContext.Provider;

/** null outside the Edit view — place fields elsewhere keep their file-only list. */
export function usePlaceLookup(): PlaceLookup | null {
  return useContext(PlaceLookupContext);
}

/** At most this many offers, however many registers answered. */
const MAX_RESULTS = 10;

/**
 * The imported gazetteer, built once per session. Only a non-empty index is
 * cached: with nothing imported yet the read is cheap, and re-reading means an
 * import made in Tools starts answering here without a reload.
 */
let cachedIndex: GazetteerIndex | undefined;
async function gazetteerIndex(): Promise<GazetteerIndex | undefined> {
  if (cachedIndex) return cachedIndex;
  const stored = await loadCountries();
  if (!stored.length) return undefined;
  cachedIndex = buildGazetteerIndex(stored.flatMap((c) => c.entries));
  return cachedIndex;
}

/** Build the Edit view's lookup: this file's place style plus every register. */
export function usePlaceLookupValue(dataset: Dataset, placeSuggestions: string[]): PlaceLookup {
  const { settings } = useSettings();
  const { i18n } = useTranslation();
  const online = settings.allowLinkFetch;
  const language = i18n.language;

  return useMemo(() => {
    const style: PlaceStyle = {
      fmt: inferPlaceExportFormat(dataset),
      depth: placeDepthOf(placeSuggestions),
      language,
    };

    const search = async (query: string): Promise<PlaceProposal[]> => {
      const text = query.trim();
      if (text.length < 2) return [];

      const out: PlaceProposal[] = [];
      const seen = new Set<string>();
      const add = (proposal: PlaceProposal | undefined) => {
        if (!proposal) return;
        const key = proposalKey(proposal);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(proposal);
      };

      // Offline first: an imported register answers instantly, is authoritative
      // for the country it covers, and costs no request.
      const index = await gazetteerIndex();
      if (index) for (const entry of searchGazetteer(index, text)) add(proposalFromGazEntry(entry, style));

      if (online) {
        // The address register only applies when the text names a house number
        // in Slovenia; the other two take any free text.
        const rnQueries = rnQueriesFrom(text, undefined);
        const [rn, gov, osm] = await Promise.allSettled([
          rnQueries.length ? searchAddresses(rnQueries) : Promise.resolve([]),
          searchGov(text, language),
          searchNominatim(text, language),
        ]);
        if (rn.status === "fulfilled") for (const r of rn.value) add(proposalFromRn(r, style));
        if (gov.status === "fulfilled") for (const r of gov.value) add(proposalFromGov(r, style));
        if (osm.status === "fulfilled") for (const r of osm.value) add(proposalFromNominatim(r, style));
        // Every register that was asked failed: that is an error to report, not
        // an empty result ("no such place") — they say opposite things.
        if (!out.length && gov.status === "rejected" && osm.status === "rejected") {
          throw new Error("place lookup failed");
        }
      }

      return out.slice(0, MAX_RESULTS);
    };

    return { search, online };
  }, [dataset, placeSuggestions, language, online]);
}
