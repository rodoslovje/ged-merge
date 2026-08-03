import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Dataset, Individual, PersonName } from "../gedcom/types";
import { marriedSurnamesOf, primaryName } from "../match/relatives";
import {
  DEFAULT_NAME_DISPLAY,
  formatPersonName,
  type NameDisplayOptions,
  type NameOrder,
} from "../gedcom/nameDisplay";
import { sanitizeFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import type { NativePyramid } from "./map/tilePlan";
import { CUSTOM_BASEMAP, isKnownBasemap } from "./map/basemapPresets";

// App-wide user preferences, persisted to localStorage so they stick across
// sessions. Follows the same shape as ChartSettingsContext: one provider near
// the root, a `set(patch)` updater, and a tolerant `load()` so older saved
// blobs (missing newer keys) fall back to defaults field by field.

/** One user-configured historical map overlay: a tile URL template with a
 *  validity period. The Map chart offers configured layers in its overlay
 *  picker and highlights the ones whose years match the selected window. */
export interface MapOverlay {
  /** Stable identity (generated on add) — the picker's on/off key. */
  id: string;
  /** User-visible name. Empty for a preset-added layer (its display name comes
   *  from {@link presetKey} via i18n); a non-empty value is a manual override. */
  name: string;
  /** i18n key of the preset this layer was added from — resolved to the
   *  localized name for display unless {@link name} overrides it. */
  presetKey?: string;
  /** XYZ / WMTS-REST tile URL template with {z}/{x}/{y} placeholders — or, when
   *  {@link wms} is set, the OGC WMS service base endpoint (Leaflet appends the
   *  GetMap query itself). */
  url: string;
  /** When set, the overlay is an OGC WMS layer drawn via `L.tileLayer.wms`:
   *  {@link url} is the service endpoint and {@link layers} names the layers. */
  wms?: boolean;
  /** Comma-separated WMS layer name(s) — only used when {@link wms} is set.
   *  A layer may be repeated to stack styles (e.g. boundaries + name labels). */
  layers?: string;
  /** Comma-separated WMS `STYLES`, aligned 1:1 with {@link layers}. Empty means
   *  each layer's default style. Used to add a label style over a geometry one. */
  styles?: string;
  /** WMS tile size in px (default 256). Label styles are rendered per tile and
   *  clip at seams, so label overlays use a large tile to stay near-untiled. */
  tileSize?: number;
  /** When set (WMS only), the overlay is click-queryable: a map click fires a
   *  WMS GetFeatureInfo against these `QUERY_LAYERS` and shows the returned
   *  attributes in a popup. Often the same as {@link layers}, but may name a
   *  richer sibling (e.g. display house-number symbols, query the address). */
  queryLayers?: string;
  /** Extra WMS GetMap query params as a raw `KEY=value&KEY=value` string
   *  (e.g. `TIME=2011-01-01T00:00:00.000Z` for a time-enabled layer, or a
   *  `CQL_FILTER`). Only used when {@link wms} is set. */
  params?: string;
  /** When set (WMS only), the service will not draw this layer in Web Mercator,
   *  so tiles are requested in this CRS and reprojected in the browser (see
   *  reprojectedWmsLayer). Only CRSs with a bundled projection work. */
  nativeCrs?: string;
  /** The layer's extent in {@link nativeCrs} units, `[minX, minY, maxX, maxY]`
   *  — tiles outside it are skipped instead of requested. */
  nativeBounds?: [number, number, number, number];
  /** The layer's coarsest usable scale denominator (its WMS
   *  `MaxScaleDenominator`): above it the service returns a blank image, so a
   *  reprojected layer asks for a larger image to get under it. */
  maxScaleDenominator?: number;
  /** Take the imagery from a pre-cut WMTS tile pyramid rather than a free-form
   *  GetMap — some layers are published only through a tile cache. Reprojected
   *  layers only; see {@link NativePyramid}. */
  pyramid?: NativePyramid;
  /** Switch this layer on wherever a map is drawn — the Map chart opens with
   *  it already ticked, and the small place maps show it too. A per-map picker
   *  toggle still wins for that map's session. */
  defaultOn?: boolean;
  /** Validity period (either end open) — drives the era suggestion. */
  yearFrom?: number;
  yearTo?: number;
  /** Attribution required by the layer's source, shown on map + PNG export. */
  attribution?: string;
  /** Lowest zoom the layer is drawn at. Used by detailed sources that render
   *  nothing (or nothing legible) when zoomed out. */
  minZoom?: number;
  /** Highest zoom the source provides; deeper views scale those tiles.
   *  Ignored for WMS layers, which render at any zoom. */
  maxZoom?: number;
}

export interface AppSettings extends NameDisplayOptions {
  /** Show each person's record id (xref) alongside their name. */
  showXref: boolean;
  /** Show the kinship-to-start-person label/badge throughout the app (person
   *  headers, relative cards, match candidates, tree nodes). When off, no
   *  kinship is shown anywhere even if a start person is set. */
  showKinship: boolean;
  /** Show ages: at death after the lifespan (current age for the living), the
   *  person's age next to each event date, and the parents'/spouses' ages on
   *  birth and family events. */
  showAge: boolean;
  /** Allow looking up link metadata through the public CORS relay (opt-in:
   *  this is the one feature that sends a URL off the user's machine). */
  allowLinkFetch: boolean;
  /** Allow the Map chart to load base-map tiles from the tile provider
   *  (opt-in: tile requests reveal the viewed region). Until enabled the map
   *  draws on the bundled offline world outline. */
  allowMapTiles: boolean;
  /** Show the small per-person places map under the Edit view's events. */
  showEditMap: boolean;
  /** Which base map the Map chart draws: a {@link BASEMAPS} preset id ("" =
   *  the default), or CUSTOM_BASEMAP to use {@link mapTileUrl}. */
  mapBasemap: string;
  /** Custom XYZ tile URL template ({z}/{x}/{y}), used when `mapBasemap` is
   *  CUSTOM_BASEMAP. */
  mapTileUrl: string;
  /** Historical map overlay layers (bring-your-own tile URLs + presets). */
  mapOverlays: MapOverlay[];
  /** User overrides for the detected file-format conventions (dates, places,
   *  names, sources, links…). Absent fields mean "Detected" — the tools
   *  follow the file's own habit. See {@link FormatOverrides}. */
  formatOverrides: FormatOverrides;
  /** Cache the loaded files + progress to IndexedDB so a reload restores the
   *  workspace. Opt-in: off by default, and only when on may the browser be
   *  asked for persistent storage. */
  persistWorkspace: boolean;
}

const DEFAULTS: AppSettings = {
  ...DEFAULT_NAME_DISPLAY,
  showXref: false,
  showKinship: true,
  showAge: false,
  allowLinkFetch: false,
  allowMapTiles: false,
  showEditMap: true,
  mapBasemap: "",
  mapTileUrl: "",
  mapOverlays: [],
  formatOverrides: {},
  persistWorkspace: false,
};

const STORAGE_KEY = "gedmerge.settings";

interface SettingsCtx {
  settings: AppSettings;
  set: (patch: Partial<AppSettings>) => void;
}

/**
 * Preferences held outside React and read by subscription rather than handed
 * down as a context *value*.
 *
 * A plain value context re-renders every consumer on every change, and the
 * consumers here include the whole App component plus both mounted views — so
 * adjusting one preference re-rendered the entire app, however unrelated it
 * was. (Typing a map overlay's name in Settings did it once per keystroke.)
 * With a store the context value never changes; each component subscribes to
 * the fields it actually reads through {@link useSettingsSlice} and sits out
 * changes to the rest.
 */
interface SettingsStore {
  /** The current preferences. Stable between changes, so it can be compared. */
  get: () => AppSettings;
  /** Register for a callback on every change; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  set: (patch: Partial<AppSettings>) => void;
}

function createSettingsStore(): SettingsStore {
  let current = load();
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    set(patch) {
      current = { ...current, ...patch };
      save(current);
      // Copy first: a listener may unsubscribe as it runs.
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Stand-in for a tree with no provider — the defaults, and changes go nowhere. */
const NO_STORE: SettingsStore = {
  get: () => DEFAULTS,
  subscribe: () => () => {},
  set: () => {},
};

export const SettingsContext = createContext<SettingsStore>(NO_STORE);

/** The overlay's localized display name: a manual {@link MapOverlay.name}
 *  override wins; otherwise a preset resolves through i18n; else the URL. */
export function overlayDisplayName(o: MapOverlay, translate: (key: string) => string): string {
  if (o.name) return o.name;
  if (o.presetKey) return translate(o.presetKey);
  return o.url;
}

/** True for an array of exactly `n` finite numbers. */
function isFiniteTuple(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** Keep a stored tile-pyramid definition only if every field it needs is there
 *  — a half-read pyramid would request nonsense tiles. */
function sanitizePyramid(v: unknown): NativePyramid | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Partial<NativePyramid>;
  if (typeof p.layer !== "string" || !p.layer) return undefined;
  if (typeof p.tileMatrixSet !== "string" || !p.tileMatrixSet) return undefined;
  if (typeof p.tileSize !== "number" || !Number.isFinite(p.tileSize) || p.tileSize <= 0) return undefined;
  if (!isFiniteTuple(p.origin, 2)) return undefined;
  if (!Array.isArray(p.scaleDenominators) || !p.scaleDenominators.length) return undefined;
  if (!p.scaleDenominators.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)) return undefined;
  const out: NativePyramid = {
    layer: p.layer,
    tileMatrixSet: p.tileMatrixSet,
    scaleDenominators: [...p.scaleDenominators],
    origin: [p.origin[0], p.origin[1]],
    tileSize: p.tileSize,
  };
  if (typeof p.format === "string" && p.format) out.format = p.format;
  return out;
}

/** Keep only well-formed overlay entries from a stored blob. */
function sanitizeOverlays(v: unknown): MapOverlay[] {
  if (!Array.isArray(v)) return [];
  const out: MapOverlay[] = [];
  for (const o of v as Partial<MapOverlay>[]) {
    if (!o || typeof o.id !== "string" || typeof o.name !== "string" || typeof o.url !== "string") continue;
    const layer: MapOverlay = { id: o.id, name: o.name, url: o.url };
    if (typeof o.presetKey === "string" && o.presetKey) layer.presetKey = o.presetKey;
    if (o.wms === true) layer.wms = true;
    if (typeof o.layers === "string" && o.layers) layer.layers = o.layers;
    if (typeof o.styles === "string" && o.styles) layer.styles = o.styles;
    if (typeof o.tileSize === "number" && Number.isFinite(o.tileSize)) layer.tileSize = o.tileSize;
    if (typeof o.queryLayers === "string" && o.queryLayers) layer.queryLayers = o.queryLayers;
    if (typeof o.params === "string" && o.params) layer.params = o.params;
    if (o.defaultOn === true) layer.defaultOn = true;
    if (typeof o.yearFrom === "number" && Number.isFinite(o.yearFrom)) layer.yearFrom = o.yearFrom;
    if (typeof o.yearTo === "number" && Number.isFinite(o.yearTo)) layer.yearTo = o.yearTo;
    if (typeof o.attribution === "string" && o.attribution) layer.attribution = o.attribution;
    if (typeof o.minZoom === "number" && Number.isFinite(o.minZoom)) layer.minZoom = o.minZoom;
    if (typeof o.maxZoom === "number" && Number.isFinite(o.maxZoom)) layer.maxZoom = o.maxZoom;
    // Reprojection config. A preset layer gets this back from the preset, but a
    // layer the user has edited is detached and carries its own — drop it here
    // and that layer would come back as a plain Web Mercator request, which is
    // exactly what the service can't answer.
    if (typeof o.nativeCrs === "string" && o.nativeCrs) layer.nativeCrs = o.nativeCrs;
    if (isFiniteTuple(o.nativeBounds, 4)) layer.nativeBounds = [...o.nativeBounds] as [number, number, number, number];
    if (typeof o.maxScaleDenominator === "number" && Number.isFinite(o.maxScaleDenominator)) {
      layer.maxScaleDenominator = o.maxScaleDenominator;
    }
    const pyramid = sanitizePyramid(o.pyramid);
    if (pyramid) layer.pyramid = pyramid;
    out.push(layer);
  }
  return out;
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    const order: NameOrder = parsed.order === "surname-given" ? "surname-given" : "given-surname";
    return {
      order,
      uppercaseSurname: bool(parsed.uppercaseSurname, DEFAULTS.uppercaseSurname),
      marriedSurname: bool(parsed.marriedSurname, DEFAULTS.marriedSurname),
      showXref: bool(parsed.showXref, DEFAULTS.showXref),
      showKinship: bool(parsed.showKinship, DEFAULTS.showKinship),
      showAge: bool(parsed.showAge, DEFAULTS.showAge),
      allowLinkFetch: bool(parsed.allowLinkFetch, DEFAULTS.allowLinkFetch),
      allowMapTiles: bool(parsed.allowMapTiles, DEFAULTS.allowMapTiles),
      // Legacy home of this preference (before it moved into Settings).
      showEditMap: bool(parsed.showEditMap, localStorage.getItem("gedmerge-edit-map-hidden") !== "true"),
      mapTileUrl: typeof parsed.mapTileUrl === "string" ? parsed.mapTileUrl : DEFAULTS.mapTileUrl,
      mapBasemap:
        typeof parsed.mapBasemap === "string" && isKnownBasemap(parsed.mapBasemap)
          ? parsed.mapBasemap
          : // Saved before the picker existed, when a tile URL meant "custom".
            typeof parsed.mapTileUrl === "string" && parsed.mapTileUrl.trim()
            ? CUSTOM_BASEMAP
            : DEFAULTS.mapBasemap,
      mapOverlays: sanitizeOverlays(parsed.mapOverlays),
      formatOverrides: {
        // Legacy key from the first page-media release, folded into overrides.
        ...((parsed as { sourcePageMedia?: string }).sourcePageMedia === "event" ||
        (parsed as { sourcePageMedia?: string }).sourcePageMedia === "source"
          ? { pageMedia: (parsed as { sourcePageMedia?: "event" | "source" }).sourcePageMedia }
          : {}),
        ...sanitizeFormatOverrides(parsed.formatOverrides),
      },
      persistWorkspace: bool(parsed.persistWorkspace, DEFAULTS.persistWorkspace),
    };
  } catch {
    return DEFAULTS;
  }
}

function save(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable / quota — settings stay in-memory for this session
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  // Created once and never replaced, so the provider itself never re-renders
  // on a preference change — only the components subscribed to what changed.
  const [store] = useState(createSettingsStore);
  return <SettingsContext.Provider value={store}>{children}</SettingsContext.Provider>;
}

/**
 * The fields named, re-rendering only when one of *those* changes. `keys`
 * should be a module-level constant; the returned object keeps its identity
 * for as long as every named field does, so it is safe as an effect or memo
 * dependency.
 */
export function useSettingsSlice<K extends keyof AppSettings>(keys: readonly K[]): Pick<AppSettings, K> {
  const store = useContext(SettingsContext);
  const cache = useRef<Pick<AppSettings, K> | null>(null);
  const snapshot = useCallback(() => {
    const all = store.get();
    const prev = cache.current;
    if (prev && keys.every((k) => Object.is(prev[k], all[k]))) return prev;
    const next = {} as Pick<AppSettings, K>;
    for (const k of keys) next[k] = all[k];
    cache.current = next;
    return next;
  }, [store, keys]);
  return useSyncExternalStore(store.subscribe, snapshot);
}

/** Update preferences without subscribing to them — a component that only
 *  writes never re-renders for someone else's change. */
export function useSetSettings(): (patch: Partial<AppSettings>) => void {
  return useContext(SettingsContext).set;
}

/**
 * Every preference at once. Convenient, but it re-renders the caller on *any*
 * change — prefer {@link useSettingsSlice} in anything large or repeated per
 * row, and keep this for small components and one-off dialogs.
 */
export function useSettings(): SettingsCtx {
  const store = useContext(SettingsContext);
  const settings = useSyncExternalStore(store.subscribe, store.get);
  return useMemo(() => ({ settings, set: store.set }), [settings, store]);
}

/** The loaded main dataset, provided near the root so {@link useNameOf} can
 *  order a person's married surnames by their unions without every name call
 *  site threading the dataset through. */
const DatasetContext = createContext<Dataset | undefined>(undefined);

export function DatasetProvider({ dataset, children }: { dataset: Dataset | undefined; children: ReactNode }) {
  return <DatasetContext.Provider value={dataset}>{children}</DatasetContext.Provider>;
}

/**
 * A name formatter bound to the current Name-display settings. Returns a stable
 * function for either a structured `PersonName` or an `Individual` (its primary
 * name), so the existing `displayName(primaryName(indi))` call sites become
 * `nameOf(indi)`.
 */
const NAME_DISPLAY_KEYS = ["order", "uppercaseSurname", "marriedSurname"] as const;

export function useNameOf(overrides?: Partial<NameDisplayOptions>) {
  // Only the three name-display fields: this hook is called on every list row
  // in the app, and its identity change invalidates the callers' memos — so it
  // must not move when an unrelated preference does.
  const settings = useSettingsSlice(NAME_DISPLAY_KEYS);
  const ds = useContext(DatasetContext);
  return useCallback(
    (subject: Individual | PersonName | undefined): string => {
      // Callers may pin individual display options (e.g. the reports drop the
      // married-surname parenthetical); pass a module-level constant so the
      // returned formatter keeps a stable identity.
      const opts = overrides ? { ...settings, ...overrides } : settings;
      // For an Individual, resolve the married surname(s) from the whole record
      // (inline `_MARNM` *or* separate `TYPE married` NAMEs) so both styles
      // work. Multiple marriages show every married surname, comma-separated,
      // in union order (maiden-surname repeats dropped).
      if (subject && "names" in subject) {
        const primary = primaryName(subject);
        const surname = primary?.surname?.trim().toLowerCase();
        const married = opts.marriedSurname
          ? marriedSurnamesOf(subject, ds).filter((m) => m.toLowerCase() !== surname).join(", ") || undefined
          : undefined;
        return formatPersonName(primary ? { ...primary, married } : undefined, opts);
      }
      return formatPersonName(subject, opts);
    },
    [settings, overrides, ds],
  );
}
