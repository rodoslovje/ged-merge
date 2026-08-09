import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildPlaceSuggestions, type PlaceSuggestions } from "./edit/placeSuggestions";
import { scanAddresses, type AddressRow } from "../tools/addresses";
import { createKinshipResolver, type KinshipResolver } from "../match/kinship";
import {
  detectHomeCountry,
  detectHomeCountryFromRegister,
  resolveHomeCountry,
  HOME_COUNTRY_AUTO,
  type HomeCountryDetection,
  type RegisterVote,
} from "../geo/homeCountry";
import { collectPlaceValues } from "../tools/geocode";
import { gazetteerGeneration, gazetteerIndex } from "./edit/PlaceLookupContext";
import { useSettingsSlice } from "./SettingsContext";

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
  /** Every PLAC value the file writes, in file order and with repeats — the
   *  raw material both readings of the home country are counted from. */
  placeValues: () => string[];
  /** Which country the file's own places say it is about — the one assumed for
   *  the places that name none. Read through {@link useHomeCountry}, which
   *  applies the reader's setting on top. */
  homeCountry: () => HomeCountryDetection;
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
    const placeValues = lazy(() => collectPlaceValues(dataset));
    return {
      version,
      placeSuggestions: lazy(() => buildPlaceSuggestions(dataset)),
      addressRows: lazy(() => scanAddresses(dataset)),
      placeValues,
      homeCountry: lazy(() => detectHomeCountry(placeValues())),
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

const HOME_KEYS = ["homeCountry"] as const;

/** What the file is taken to be about, and on whose word. */
export interface HomeCountryAnswer {
  /** ISO code (lower case), `""` where nothing is to be assumed. */
  code: string;
  /** Whose reading it is: the file's own country names, or — for a file that
   *  writes none — the directories that hold its places. `""` when neither
   *  could say. */
  source: "file" | "register" | "";
  /** The file's own words, counted (what Settings reports about the file). */
  detection: HomeCountryDetection;
  /** The directories' vote, when one was needed and could be taken. */
  register: RegisterVote;
}

const NO_VOTE: RegisterVote = { code: "", examined: 0, decided: 0, won: 0 };
const NO_DETECTION: HomeCountryDetection = { code: "", spelling: "", named: 0, namedTotal: 0, unnamed: 0 };

/**
 * The directories' vote per (dataset, directories), shared by every list on the
 * page. It costs a pass over every place the file writes and a read of
 * IndexedDB, so it is taken once and handed to whoever asks — and taken again
 * only when the file is edited or a directory is imported or removed.
 */
let voteCache: { key: string; vote: RegisterVote } | null = null;
let voteInFlight = "";
const voteListeners = new Set<() => void>();
function subscribeVote(listener: () => void): () => void {
  voteListeners.add(listener);
  return () => voteListeners.delete(listener);
}
function voteSnapshot() {
  return voteCache;
}

/**
 * What the imported directories say about a file whose own places name no
 * country — `""` until they have answered, and while they are being asked.
 *
 * Only asked for where it would be used: a file that names its own country, or
 * a reader who has chosen one by hand, never touches the directories at all.
 */
function useRegisterHomeCountry(derivations: DatasetDerivations | null, wanted: boolean): RegisterVote {
  const key = wanted && derivations ? `${derivations.version}:${gazetteerGeneration()}` : "";
  const cached = useSyncExternalStore(subscribeVote, voteSnapshot, voteSnapshot);
  useEffect(() => {
    if (!key || !derivations || voteCache?.key === key || voteInFlight === key) return;
    voteInFlight = key;
    void (async () => {
      const index = await gazetteerIndex();
      const vote = index ? detectHomeCountryFromRegister(derivations.placeValues(), index) : NO_VOTE;
      // A vote taken for a file that has since been edited, or against
      // directories that have since changed, is not this key's answer — but the
      // key it *was* taken for is now the current one only if nothing moved, so
      // the guard is on the flight, not on the result.
      if (voteInFlight !== key) return;
      voteInFlight = "";
      voteCache = { key, vote };
      for (const listener of voteListeners) listener();
    })();
  }, [key, derivations]);
  return cached?.key === key ? cached.vote : NO_VOTE;
}

/**
 * The country to assume for a place that names none, and where the answer came
 * from — the reader's setting over the file's own words, and those over the
 * directories' vote for a file that writes no country at all.
 */
export function useHomeCountryDetection({ evenWhenUnused = false } = {}): HomeCountryAnswer {
  const { homeCountry } = useSettingsSlice(HOME_KEYS);
  const derivations = useDatasetDerivations();
  // Detection is lazy and cached per dataset version, so asking on every render
  // costs a map lookup — but only where the setting actually follows the file.
  const auto = homeCountry === HOME_COUNTRY_AUTO;
  const detection = derivations?.homeCountry() ?? NO_DETECTION;
  // The file's own words come first and are cheap; the directories are only
  // asked where the file itself said nothing — and, unless Settings is on
  // screen to report what following the file would give, only where the reader
  // is actually following it.
  const register = useRegisterHomeCountry(derivations, (auto || evenWhenUnused) && !detection.code);
  const detected = detection.code || register.code;
  return {
    code: auto ? detected : "",
    source: detection.code ? "file" : register.code ? "register" : "",
    detection,
    register,
  };
}

/**
 * The country to assume for a place that names none — the reader's setting over
 * what the file says about itself, `""` where nothing is to be assumed.
 *
 * Every list that groups, scopes or judges by country asks this, so the four
 * chip rows, the gazetteer lookups and the compliance check all take the same
 * view of one file.
 */
export function useHomeCountry(): string {
  const { homeCountry } = useSettingsSlice(HOME_KEYS);
  const { code } = useHomeCountryDetection();
  return resolveHomeCountry(homeCountry, code);
}
