import { createContext, useContext, useRef } from "react";
import type { Dataset } from "../../gedcom/types";
import { buildPlaceAddrUses, NO_PLACE_ADDR_USES, type PlaceAddrUses } from "../../tools/places";
import { placeAddrKey } from "../../tools/geocode";
import { useStableHandler } from "./useStableHandler";

// Who else the file puts at the place and address a coordinate is being picked
// for. The panel is opened on a bare address — "Ravna Gora 227" — and the
// names at it are what says whether the house being pinned is the right one;
// until now they could only be found by leaving the row for the place tree.
//
// Supplied through a context for the same reason the coordinate share is: the
// panel sits at the end of a long chain of event-row components in Edit and of
// worklist rows in Tools, and neither host wants the dataset threaded through
// all of them. Both hosts provide it, so the list appears wherever the panel
// does.

export interface PlacePeople {
  /** The live file, for the person links the list is drawn as. */
  dataset: Dataset;
  /** What the file writes at this exact place + address. */
  usesAt: (place: string, address: string) => PlaceAddrUses;
  /** Open one of those records in Edit. */
  onNavigate: (id: string) => void;
}

const PlacePeopleContext = createContext<PlacePeople | null>(null);

export const PlacePeopleProvider = PlacePeopleContext.Provider;

/** null for a host that provides no lookup — the panel then shows no list. */
export function usePlacePeople(): PlacePeople | null {
  return useContext(PlacePeopleContext);
}

/**
 * The lookup behind the context: one walk of the file, built on the first ask
 * and kept until the file changes.
 *
 * Lazy on purpose. Its readers are an *open* coordinate panel and nothing
 * else, so building it eagerly would charge every commit — each field blur,
 * each applied tool pass — for a walk over every `PLAC` in the file that
 * nobody had asked for.
 *
 * `version` is whatever the host bumps on an edit (Edit's own tick and undo
 * counter, Tools' edit version): the dataset is mutated in place, so its
 * identity alone would never tell the index it had gone stale.
 */
export function usePlaceAddrUses(dataset: Dataset, version: string | number) {
  const cache = useRef<{ dataset: Dataset; version: string | number; index: Map<string, PlaceAddrUses> } | null>(null);
  // Identity-stable, so the memoized rows the panel hangs off keep their props.
  return useStableHandler((place: string, address: string): PlaceAddrUses => {
    let hit = cache.current;
    if (!hit || hit.dataset !== dataset || hit.version !== version) {
      cache.current = hit = { dataset, version, index: buildPlaceAddrUses(dataset) };
    }
    return hit.index.get(placeAddrKey(place.trim(), address.trim())) ?? NO_PLACE_ADDR_USES;
  });
}
