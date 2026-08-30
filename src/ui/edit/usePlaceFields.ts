import { useMemo } from "react";
import type { Dataset } from "../../gedcom/types";
import type { GazetteerIndex } from "../../geo/gazetteer";
import { collectFileCoords, type FileCoord } from "../../tools/geocode";
import { useDatasetDerivations } from "../DatasetDerivations";
import { buildPlaceSuggestions, placeCombosOf, type PlaceSuggestions } from "./placeSuggestions";
import { usePlaceLookupValue, usePlaceStyle, type PlaceLookup } from "./PlaceLookupContext";
import type { PlaceStyle } from "../../geo/placeProposal";

/**
 * Everything a page of place fields is built on: what the file already writes,
 * the pairs it writes them in, the registers behind them, the layout its own
 * places are written in, and the positions it already holds.
 *
 * The three place pages each assembled these four or five lines for
 * themselves, keyed on a scan counter of their own and carrying an eslint
 * exemption for it. The derivations are already versioned by every edit, undo
 * and redo, so the keys here are honest ones — a page cannot forget to bump its
 * own counter and read a stale list, which is the bug this app keeps
 * re-learning.
 */
export function usePlaceFields(
  dataset: Dataset,
  options: {
    /**
     * How many jurisdiction levels a register offer should carry, where the
     * file's own habit is not what the page wants — the naming check reads its
     * answers to tell places apart and writes them out in full.
     */
    depth?: number;
    /** Loaded directories, which is what lets the style tell a county from a
     *  municipality. */
    index?: GazetteerIndex;
  } = {},
): {
  placeSug: PlaceSuggestions;
  /** Every place+address pair the file writes, for the fields that offer both. */
  placeCombos: { place: string; addr: string }[];
  lookup: PlaceLookup;
  style: PlaceStyle;
  fileCoords: FileCoord[];
} {
  const derivations = useDatasetDerivations();
  // Keyed on the derivations themselves: their identity changes with the edit
  // version, which is exactly when the file's places may have.
  const placeSug = useMemo(
    () => derivations?.placeSuggestions() ?? buildPlaceSuggestions(dataset),
    [derivations, dataset],
  );
  const placeCombos = useMemo(() => placeCombosOf(placeSug.placeToAddrs, placeSug.placeCanonical), [placeSug]);
  const fileCoords = useMemo(
    () => derivations?.fileCoords() ?? collectFileCoords(dataset),
    [derivations, dataset],
  );
  const lookup = usePlaceLookupValue(dataset, placeSug.placeSuggestions, options.depth);
  const style = usePlaceStyle(dataset, placeSug.placeSuggestions, options.index);
  return { placeSug, placeCombos, lookup, style, fileCoords };
}
