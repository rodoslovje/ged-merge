import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildPlaceSuggestions, type PlaceSuggestions } from "./edit/placeSuggestions";
import { scanAddresses, type AddressRow } from "../tools/addresses";
import { createKinshipResolver, type KinshipResolver } from "../match/kinship";

/**
 * Whole-file derivations of the main dataset, computed once per edit and
 * shared by every view that needs them.
 *
 * The dataset is mutated in place, so a memo over its identity silently goes
 * stale — the bug class this app keeps re-learning. Consumers used to derive
 * independently: the place suggestions ran in Edit *and* the geocode panel
 * (both stay mounted, so twice per edit), the address scan in two panels, and
 * kinship resolvers were rebuilt at seven sites — two of which forgot the
 * version key and showed stale labels. Here every getter is keyed on
 * `version` (`editVersion`: bumped by every commit, tool batch, undo, redo
 * and save-rebuild) and computed lazily on first use per version, so an
 * Edit-only session never pays for the address scan.
 */
export interface DatasetDerivations {
  /** Bumped on every dataset mutation — safe to use as a memo key. */
  version: number;
  /** Place/address suggestions from every value the file holds. */
  placeSuggestions: () => PlaceSuggestions;
  /** The place+address rows of the whole file (the Addresses tab's unit). */
  addressRows: () => AddressRow[];
  /** Kinship labels from the start person; undefined without one. */
  kinship: (startId: string | undefined) => KinshipResolver | undefined;
}

const Ctx = createContext<DatasetDerivations | null>(null);

/** One lazily computed value per provider generation. */
function lazy<T>(compute: () => T): () => T {
  let value: T | undefined;
  let has = false;
  return () => {
    if (!has) {
      value = compute();
      has = true;
    }
    return value as T;
  };
}

export function DatasetDerivationsProvider({
  dataset,
  version,
  children,
}: {
  dataset: Dataset | undefined;
  version: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // Kinship additionally varies by start person; cached per (version, startId).
  const kinshipCache = useRef<{ version: number; startId: string; resolver: KinshipResolver } | null>(null);
  const value = useMemo<DatasetDerivations | null>(() => {
    if (!dataset) return null;
    return {
      version,
      placeSuggestions: lazy(() => buildPlaceSuggestions(dataset)),
      addressRows: lazy(() => scanAddresses(dataset)),
      kinship: (startId) => {
        if (!startId) return undefined;
        const hit = kinshipCache.current;
        if (hit && hit.version === version && hit.startId === startId) return hit.resolver;
        const resolver = createKinshipResolver(dataset, startId, t);
        kinshipCache.current = { version, startId, resolver };
        return resolver;
      },
    };
  // t changes identity with the language; the resolver's labels follow it.
  }, [dataset, version, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The shared derivations; throws where no main dataset can be loaded. */
export function useDatasetDerivations(): DatasetDerivations | null {
  return useContext(Ctx);
}
