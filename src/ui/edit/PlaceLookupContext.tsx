import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  buildGazetteerIndex,
  mergeDivisions,
  searchGazetteer,
  storedEntries,
  type GazetteerIndex,
} from "../../geo/gazetteer";
import { searchGov } from "../../geo/gov";
import { placeLookupLanguage } from "../../geo/lookupLanguage";
import { inferPlaceParentLevels, type PlaceParentLevels } from "../../geo/placeLevels";
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
import { applyPlaceOverrides } from "../../normalize/formatOverrides";
import { inferPlaceExportFormat } from "../../normalize/profile";
import type { PlaceTargetFormat } from "../../normalize/types";
import { loadCountries } from "../../persist/geoDb";
import { useSettingsSlice } from "../SettingsContext";

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
  /**
   * The same for an address being typed, which is looked up *within* the event's
   * place: "21" or "Hafnarjeva pot 21" means nothing on its own, and the house
   * the address register finds may well turn out to belong to a neighbouring
   * settlement — so an offer carries the place it really is in, not the one that
   * was typed. Only the online registers hold house numbers; an imported
   * gazetteer stops at settlements.
   */
  searchAddress: (place: string, address: string) => Promise<PlaceProposal[]>;
  /** Whether the online registers may be queried at all (Settings → online
   *  lookups). When off, only an imported gazetteer answers — and the panel
   *  says so instead of silently returning less. */
  online: boolean;
}

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["allowLinkFetch", "formatOverrides"] as const;

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
export async function gazetteerIndex(): Promise<GazetteerIndex | undefined> {
  if (cachedIndex) return cachedIndex;
  const stored = await loadCountries();
  if (!stored.length) return undefined;
  cachedIndex = buildGazetteerIndex(storedEntries(stored), mergeDivisions(stored));
  return cachedIndex;
}

/** Bumped whenever the stored directories change. Anything that reads an answer
 *  *out of* the index — rather than the index itself — keys its own cache on
 *  this, since a rebuilt index is a different answer (see the home country the
 *  directories vote for in DatasetDerivations). */
let generation = 0;
export function gazetteerGeneration(): number {
  return generation;
}

/** Drop the cached index after the stored gazetteers change — a re-import of a
 *  register the session already read (say, to pick up a field the older import
 *  did not carry) would otherwise keep answering from the old entries until the
 *  page is reloaded. Called by the Geocode tool whenever it writes the store. */
export function invalidateGazetteerIndex(): void {
  cachedIndex = undefined;
  generation++;
}

/**
 * How this file writes places: what it does, unless Settings → GEDCOM says
 * otherwise. Anything a register hands the user — a completed place in the Edit
 * fields, the alternatives the compliance check lists — is written in it, so a
 * register's answer looks like the places already in the file rather than like
 * the register.
 */
export function usePlaceStyle(
  dataset: Dataset,
  placeSuggestions: string[],
  index?: GazetteerIndex,
): PlaceStyle {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const { i18n } = useTranslation();
  const overrides = settings.formatOverrides;
  const language = i18n.language;
  return useMemo(() => {
    const fmt = applyPlaceOverrides(inferPlaceExportFormat(dataset), overrides);
    return {
      fmt,
      depth: placeDepthOf(placeSuggestions),
      language,
      // Only a loaded directory can tell a county from a municipality; without
      // one the parent stays the municipality, as it always was.
      ...(index ? { parentLevels: inferPlaceParentLevels(placeSuggestions, index, fmt) } : {}),
    };
  }, [dataset, placeSuggestions, overrides, language, index]);
}

/** Build the Edit view's lookup: this file's place style plus every register. */
export function usePlaceLookupValue(
  dataset: Dataset,
  placeSuggestions: string[],
  /** How many jurisdiction levels an offer should carry, where that is not the
   *  file's own habit. An Edit field wants a place that looks like its
   *  neighbours — a file of bare settlements is offered "Železniki" — but the
   *  naming check is read to tell places apart and writes them out in full, and
   *  an offer cut back to the settlement there is both unrecognisable as an
   *  answer to what was typed and indistinguishable from the file's own value. */
  depth?: number,
): PlaceLookup {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const online = settings.allowLinkFetch;
  const fileStyle = usePlaceStyle(dataset, placeSuggestions);
  const style = useMemo(() => (depth ? { ...fileStyle, depth } : fileStyle), [fileStyle, depth]);

  return useMemo(() => {
    /** Collector shared by both lookups: first offer for a place wins, so the
     *  official register's wording outranks a later source's. */
    const collector = () => {
      const out: PlaceProposal[] = [];
      const seen = new Set<string>();
      return {
        out,
        add(proposal: PlaceProposal | undefined) {
          if (!proposal) return;
          const key = proposalKey(proposal);
          if (seen.has(key)) return;
          seen.add(key);
          out.push(proposal);
        },
      };
    };

    const search = async (query: string): Promise<PlaceProposal[]> => {
      const text = query.trim();
      if (text.length < 2) return [];

      const { out, add } = collector();

      // Offline first: an imported register answers instantly, is authoritative
      // for the country it covers, and costs no request.
      const index = await gazetteerIndex();
      if (index) {
        // Only a register entry has a level to choose between; the online
        // sources below name their own parent and there is nothing to pick.
        const styled = { ...style, parentLevels: parentLevelsFor(index, placeSuggestions, style.fmt) };
        for (const entry of searchGazetteer(index, text)) add(proposalFromGazEntry(entry, styled));
      }

      if (online) {
        // The address register only applies when the text names a house number
        // in Slovenia; the other two take any free text.
        const rnQueries = rnQueriesFrom(text, undefined);
        // Answered in the language the query is written in, not the reader's:
        // a file that says "United States" must get "United States" back, or
        // the proposal composed from the answer names the country twice over
        // in two languages (see placeLookupLanguage).
        const answerLang = placeLookupLanguage(text, style.language);
        const [rn, gov, osm] = await Promise.allSettled([
          rnQueries.length ? searchAddresses(rnQueries) : Promise.resolve([]),
          searchGov(text, answerLang),
          searchNominatim(text, answerLang),
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

    const searchAddress = async (place: string, address: string): Promise<PlaceProposal[]> => {
      const text = address.trim();
      // House numbers live only in the online registers, so with the opt-in off
      // there is nothing to ask (the caller doesn't offer the search then).
      if (!text || !online) return [];

      const { out, add } = collector();
      // The register reads the number against the event's place: which
      // settlement, and whether the number hangs off a street or off the
      // village itself. It also tries the wider jurisdictions the place names,
      // since a street is often filed under the town that absorbed the village.
      const rnQueries = rnQueriesFrom(place || undefined, text);
      const [rn, osm] = await Promise.allSettled([
        rnQueries.length ? searchAddresses(rnQueries) : Promise.resolve([]),
        // Address first, then the place — the order Nominatim reads best, in
        // the language the event's place is written in.
        searchNominatim(
          [text, place].map((s) => s.trim()).filter(Boolean).join(", "),
          placeLookupLanguage(place, style.language),
        ),
      ]);
      if (rn.status === "fulfilled") for (const r of rn.value) add(proposalFromRn(r, style));
      if (osm.status === "fulfilled") for (const r of osm.value) add(proposalFromNominatim(r, style));
      if (!out.length && rn.status === "rejected" && osm.status === "rejected") {
        throw new Error("address lookup failed");
      }
      return out.slice(0, MAX_RESULTS);
    };

    return { search, searchAddress, online };
  }, [style, placeSuggestions, online]);
}

/** The parent level read off this file's places and the directories loaded,
 *  kept between lookups: a search runs on every keystroke, while neither the
 *  file's places nor the index changes identity between them. */
let cachedLevels:
  | { index: GazetteerIndex; places: readonly string[]; fmt: PlaceTargetFormat; levels: PlaceParentLevels }
  | undefined;
function parentLevelsFor(
  index: GazetteerIndex,
  places: readonly string[],
  fmt: PlaceTargetFormat,
): PlaceParentLevels {
  if (cachedLevels?.index === index && cachedLevels.places === places && cachedLevels.fmt === fmt) {
    return cachedLevels.levels;
  }
  const levels = inferPlaceParentLevels(places, index, fmt);
  cachedLevels = { index, places, fmt, levels };
  return levels;
}
