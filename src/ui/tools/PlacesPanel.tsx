import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { buildPlaceTree, collectNodeUseIds, type PlaceNode, type PlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "../../tools/places";
import { previewPlaceRename, type PlaceRenamePreview } from "../../tools/placeEdit";
import type { ToolView } from "../ToolsView";
import { scanAddresses, type AddressRename } from "../../tools/addresses";
import { useDatasetDerivations } from "../DatasetDerivations";
import { GeocodePanel } from "./GeocodePanel";
import { RegisterPanel } from "./RegisterPanel";
import { countGeocodePending, placeAddrKey, type FileCoord, type GeoAssignment, type OfficialRename } from "../../tools/geocode";
import { countryCodeOfName, flagEmoji } from "../../geo/placeCountry";
import { AddressSplitField, RenameEditor, ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";
import { ToolSummary } from "./ToolSummary";
import { formatCoord } from "../../geo/points";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import { PlaceLookupProvider, usePlaceLookup } from "../edit/PlaceLookupContext";
import { usePlaceFields } from "../edit/usePlaceFields";
import type { PlaceSuggestions } from "../edit/placeSuggestions";
import { renameInValue } from "../../tools/placeEdit";
import type { PlaceProposal } from "../../geo/placeProposal";
import { PinIcon } from "../icons/PinIcon";

/** What the rename box's helpers are before it is opened — stable identities,
 *  so a row that is not being edited neither builds them nor re-renders for
 *  them. */
const EMPTY_SCOPE: Set<string> = new Set();
const EMPTY_SUGGESTIONS: string[] = [];

/** How far the row's map opens on a single coordinate: close enough to read
 *  the town and its streets, since the question a place's map answers is
 *  "which town is this pinned in", not "which country". */
const TOWN_ZOOM = 13;

/** An address row's map answers a closer question — "which building is this" —
 *  so it opens at house level, the zoom the coordinate panel fits to
 *  everywhere else. */
const HOUSE_ZOOM = 17;

/** Prune a place node to those whose name matches `q` (already lower-cased)
 * anywhere in the subtree. A node matching by name keeps its whole subtree;
 * otherwise only matching descendant branches are retained — including the
 * node's own uses, which name the ancestor and not the match, and would
 * otherwise list a town's every person under one matching address. Paths of
 * nodes that survive solely as ancestors of a match are collected in
 * `autoOpen` so they can be expanded down to (but not past) the matching
 * entries. */
function filterPlaceNode(node: PlaceNode, q: string, path: string, autoOpen: Set<string>): PlaceNode | null {
  if (node.name.toLowerCase().includes(q)) return node;
  const children: PlaceNode[] = [];
  for (const child of node.children) {
    const kept = filterPlaceNode(child, q, `${path}/${child.name}`, autoOpen);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  autoOpen.add(path);
  return { ...node, children, uses: [] };
}

/**
 * Where a place value sits in the tree: the path whose segments, read outwards,
 * are the value's own comma parts ("Kokrica, Kranj, Slovenija" →
 * `Slovenija/Kranj/Kokrica`). Null where the tree does not hold it — which is
 * what a value naming a country the file writes differently comes to.
 *
 * Read off the tree rather than composed, because only the tree knows what a
 * value decomposed to: a value naming no country hangs under the synthetic
 * bucket, and one carrying a house number keeps the house as a level below the
 * locality.
 */
function findPlacePath(roots: readonly PlaceNode[], value: string): string | null {
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .reverse();
  if (!parts.length) return null;
  const descend = (nodes: readonly PlaceNode[], depth: number, path: string): string | null => {
    const node = nodes.find((n) => n.name === parts[depth]);
    if (!node) return null;
    const here = path ? `${path}/${node.name}` : node.name;
    return depth === parts.length - 1 ? here : descend(node.children, depth + 1, here);
  };
  // A value naming no country is filed under the synthetic bucket, which is a
  // level of the tree and not a part of the value.
  const unspecified = roots.find((r) => r.name === UNSPECIFIED);
  return descend(roots, 0, "") ?? (unspecified ? descend(unspecified.children, 0, UNSPECIFIED) : null);
}

/** Keys to open on first load: when there is a single root place, open it and
 *  drill on through any single-child chain so the tree lands on the first level
 *  that offers a choice. */
function initialPlaceOpen(roots: PlaceNode[]): Set<string> {
  const open = new Set<string>();
  if (roots.length !== 1) return open;
  let node = roots[0];
  let path = node.name;
  open.add(path);
  while (node.children.length === 1 && node.uses.length === 0) {
    node = node.children[0];
    path = `${path}/${node.name}`;
    open.add(path);
  }
  return open;
}

export function PlacesPanel({
  dataset,
  onNavigate,
  active,
  onApplyPlaceRename,
  onApplyGeocode,
  onApplyAddressCoords,
  onClearPlaceCoords,
  onRenamePlaceValue,
  onApplyOfficialNames,
  onRenameAddresses,
  editVersion,
  onMovePlaceForAddresses,
  startId,
  view: viewProp,
  onViewChange,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
  onApplyGeocode: (assignments: Map<string, GeoAssignment>) => number;
  onApplyAddressCoords: (assignments: Map<string, GeoCoord>) => number;
  onClearPlaceCoords: (pairs: Set<string>) => number;
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
  onApplyOfficialNames: (renames: OfficialRename[]) => number;
  onRenameAddresses: (renames: AddressRename[]) => number;
  editVersion: number;
  onMovePlaceForAddresses: (keys: Set<string>, toPlace: string, coord?: GeoAssignment) => number;
  startId?: string;
  /** Which of this tool's pages is open, and the way to another — held by the
   *  app, because each is a browser-history step (see ToolView). A page this
   *  panel does not have (another tool's) reads as its own tree. */
  view: ToolView;
  onViewChange: (view: ToolView) => void;
}) {
  const { t } = useTranslation();
  const derivations = useDatasetDerivations();
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Which page is on screen: the containment tree, the geocoding worklist or
  // the naming report. The panel is told, rather than deciding — see the prop.
  const view = viewProp === "geocode" || viewProp === "register" ? viewProp : "tree";
  const setView = (next: "tree" | "geocode" | "register") => onViewChange(next);
  // Coordinates applied on one of the other pages changed the dataset in place,
  // so the tree they were left for is stale: dropped on the way back, and the
  // panel (with its chip counts) rebuilds it.
  useEffect(() => {
    if (view === "tree") setTree(null);
  }, [view]);

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) {
      const built = buildPlaceTree(dataset);
      setTree(built);
      setOpen(initialPlaceOpen(built.roots));
    }
  }, [active, tree, dataset]);

  // Expanding a place opens it and then keeps drilling through any single-child
  // chain (a node with exactly one sub-place and no usages of its own), so one
  // click lands on the first level that actually offers a choice. Collapsing
  // just closes the clicked node.
  const togglePlace = (node: PlaceNode, path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      let cur: PlaceNode = node;
      let curPath = path;
      next.add(curPath);
      while (cur.children.length === 1 && cur.uses.length === 0) {
        cur = cur.children[0];
        curPath = `${curPath}/${cur.name}`;
        next.add(curPath);
      }
      return next;
    });

  const q = useDebounced(query).trim().toLowerCase();
  const filtering = q.length > 0;

  const { roots, autoOpen } = useMemo(() => {
    const ao = new Set<string>();
    if (!tree) return { roots: [] as PlaceNode[], autoOpen: ao };
    if (!filtering) return { roots: tree.roots, autoOpen: ao };
    const r = tree.roots
      .map((node) => filterPlaceNode(node, q, node.name, ao))
      .filter((n): n is PlaceNode => n !== null);
    return { roots: r, autoOpen: ao };
  }, [tree, filtering, q]);

  // Filtering expands ancestors down to (not past) the matches; the user expands further.
  const isOpen = (key: string) => autoOpen.has(key) || open.has(key);

  // What a rename may complete to: the names beside the one being renamed, per
  // parent path. A rename is a merge into a name the *same* place already has
  // — the houses of another town are no help and read as this town's own
  // ("Breg 13 (pd Miklavž)" offered while renaming a Breg ob Kokri house).
  // Built from the unfiltered tree so a search doesn't hide merge targets.
  const siblingNames = useMemo(() => {
    const map = new Map<string, string[]>();
    const walk = (nodes: PlaceNode[], parent: string) => {
      map.set(parent, nodes.map((n) => n.name));
      for (const n of nodes) walk(n.children, parent ? `${parent}/${n.name}` : n.name);
    };
    if (tree) walk(tree.roots, "");
    return map;
  }, [tree]);

  /**
   * Rename a place level everywhere under one row, and show where it went.
   *
   * The tree the reader was working down stays exactly as open as it was. It
   * used to be replaced by the renamed value's own chain, which threw away the
   * bucket the rename was made from — correct a stray under *Unspecified
   * country* and the seventy values beside it folded away, so there was no
   * carrying on down the list.
   *
   * A coordinate a register offer brought is written before the rebuild, so one
   * rename costs one pass over the file's places rather than two.
   *
   * Where the value went is opened on top of that, read off the rebuilt tree
   * rather than guessed by substituting the new name into the old path: a
   * rename that gives a value its country moves it to another branch entirely,
   * and the old path with one segment swapped names nothing at all.
   */
  function handleRename(from: string, to: string, scope: Set<string>, coords?: Map<string, GeoCoord>) {
    onApplyPlaceRename(from, to, scope);
    if (coords?.size) onApplyAddressCoords(coords);
    const newTree = buildPlaceTree(dataset);
    setTree(newTree);
    reveal(newTree, to);
  }

  /** Open the chain down to where a renamed value now sits, leaving every row
   *  the reader had open where it was. */
  function reveal(rebuilt: PlaceTree, value: string) {
    const landed = value ? findPlacePath(rebuilt.roots, value) : null;
    if (!landed) return;
    setOpen((prev) => {
      const next = new Set(prev);
      const parts = landed.split("/");
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }

  /**
   * A row's rename that splits the value: the whole value is rewritten and the
   * house it named goes on the event's own ADDR line. The tree is rebuilt with
   * every row the reader had open still open, and the place the house now
   * stands in opened under them.
   */
  function handleRenameValue(from: string, to: string, addr: string, coords?: Map<string, GeoCoord>) {
    onRenamePlaceValue(from, to, addr);
    if (coords?.size) onApplyAddressCoords(coords);
    const newTree = buildPlaceTree(dataset);
    setTree(newTree);
    reveal(newTree, to);
  }

  /** A coordinate written or taken back in a row's panel changed the records
   *  the tree was built from, so its spots and its counts are stale. Rebuilt on
   *  the spot — and, unlike a rename, with the tree left exactly as open as it
   *  was: the row that was just placed is the one being looked at. */
  function handleCoordChange() {
    setTree(buildPlaceTree(dataset));
  }

  /**
   * What the rename box completes from, beyond the names beside the one being
   * renamed: every place value the file already writes — the same list the Edit
   * fields and both geocoding rename boxes offer — and the registers behind
   * them, so a place the file has never written properly can be completed here
   * too: its chain, its house, its coordinate. A row under *Unspecified
   * country* has siblings that are all as unplaced as it is, and what it wants
   * is one of those two.
   */
  const { placeSug, placeCombos, lookup: placeLookup, fileCoords } = usePlaceFields(dataset);

  /**
   * What the geocode tool has to offer, as the chip's two badges: distinct
   * place names still missing coordinates, and addresses a register lookup
   * could pin to their house. The tool works on either kind and a file can be
   * done with one and full of the other, so both are counted.
   *
   * Counted *after* the tree is on screen, not with it. Together they are two
   * more passes over every record — the address scan is the heaviest thing on
   * this page — and they were paid inside the render that a rename triggers, so
   * a correction to one value stood still for the length of them before
   * anything moved. The badges catch up a frame later, which is soon enough for
   * a number nobody is reading at that moment.
   */
  const [pending, setPending] = useState<{ places: number; addresses: number } | null>(null);
  useEffect(() => {
    if (!tree) return;
    let live = true;
    const id = window.setTimeout(() => {
      if (!live) return;
      setPending({
        places: countGeocodePending(dataset),
        addresses: (derivations?.addressRows() ?? scanAddresses(dataset)).filter((r) => !r.placed).length,
      });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, tree]);
  const geocodePending = pending?.places ?? 0;
  const addressPending = pending?.addresses ?? 0;

  if (!tree) return <ToolsLoading label={t("tools.running")} />;

  if (view === "register")
    return (
      <RegisterPanel
        dataset={dataset}
        active={active}
        editVersion={editVersion}
        onApplyOfficialNames={onApplyOfficialNames}
        onApplyAddressCoords={onApplyAddressCoords}
        onApplyGeocode={onApplyGeocode}
        onClearPlaceCoords={onClearPlaceCoords}
        onRenameAddresses={onRenameAddresses}
        onMovePlaceForAddresses={onMovePlaceForAddresses}
        onRenamePlaceValue={onRenamePlaceValue}
        onNavigate={onNavigate}
        startId={startId}
        onBack={() => setView("tree")}
      />
    );

  if (view === "geocode")
    return (
      <GeocodePanel
        dataset={dataset}
        active={active}
        onApplyGeocode={onApplyGeocode}
        onApplyAddressCoords={onApplyAddressCoords}
        onRenamePlaceValue={onRenamePlaceValue}
        onApplyOfficialNames={onApplyOfficialNames}
        onRenameAddresses={onRenameAddresses}
        editVersion={editVersion}
        onMovePlaceForAddresses={onMovePlaceForAddresses}
        onNavigate={onNavigate}
        startId={startId}
        onBack={() => setView("tree")}
      />
    );

  return (
    /* The rename boxes below reach the registers through this, exactly as the
       geocoding and naming pages' boxes do. */
    <PlaceLookupProvider value={placeLookup}>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <div className="tools-chip-group">
          {/* Compliance leads, and beside geocoding rather than inside it: this
              reads the whole file and says what disagrees with the registers,
              while geocoding is a worklist of what is left to place. Checking
              what you have comes before filling in what you lack — and a name
              corrected here is one the geocoder can then match. */}
          <button
            type="button"
            className="tools-chip"
            title={t("tools.places.registerChipHint")}
            onClick={() => setView("register")}
          >
            {t("tools.places.registerToggle")}
          </button>
          <button
            type="button"
            className="tools-chip"
            title={[
              t("tools.places.geocodeChipHint", { count: geocodePending }),
              addressPending > 0 ? t("tools.places.geocodeChipAddrHint", { count: addressPending }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            onClick={() => setView("geocode")}
          >
            {/* The counts name what they count, so the label drops "places" when
                either is shown — "Geocoding 55 places · 995 addresses", not
                "Geocode places 55 places". With neither, the full name stands. */}
            {t(geocodePending > 0 || addressPending > 0 ? "tools.places.geocodeToggleShort" : "tools.places.geocodeToggle")}{" "}
            {geocodePending > 0 && (
              <span className="tools-chip-count">{t("tools.places.geocodeChipPlaces", { count: geocodePending })}</span>
            )}
            {geocodePending > 0 && addressPending > 0 && " · "}
            {addressPending > 0 && (
              <span className="tools-chip-count">{t("tools.places.geocodeChipAddr", { count: addressPending })}</span>
            )}
          </button>
        </div>
        <ToolSummary>
          {t("tools.places.summary", { countries: tree.countryCount, distinct: tree.distinctCount, uses: tree.totalUses })}
        </ToolSummary>
      </div>
      {roots.length === 0 ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.places.none")}</p>
      ) : (
        <ul className="tools-tree">
          {roots.map((node) => (
            <PlaceTreeRow
              key={node.name}
              dataset={dataset}
              node={node}
              path={node.name}
              depth={0}
              isOpen={isOpen}
              toggle={togglePlace}
              onNavigate={onNavigate}
              onRename={handleRename}
              onRenameValue={handleRenameValue}
              onApplyAddressCoords={onApplyAddressCoords}
              onClearPlaceCoords={onClearPlaceCoords}
              onCoordChange={handleCoordChange}
              placeSug={placeSug}
              placeCombos={placeCombos}
              fileCoords={fileCoords}
              siblings={siblingNames.get("") ?? []}
              siblingNames={siblingNames}
            />
          ))}
        </ul>
      )}
    </PlaceLookupProvider>
  );
}

function PlaceTreeRow({
  dataset,
  node,
  path,
  depth,
  isOpen,
  toggle,
  onNavigate,
  onRename,
  onRenameValue,
  onApplyAddressCoords,
  onClearPlaceCoords,
  onCoordChange,
  placeSug,
  placeCombos,
  fileCoords,
  siblings,
  siblingNames,
}: {
  dataset: Dataset;
  node: PlaceNode;
  path: string;
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (node: PlaceNode, path: string) => void;
  onNavigate: (id: string) => void;
  /** Rename this level everywhere under the row, with the position a register
   *  offer brought along — written in the same pass, before the tree rebuild. */
  onRename: (from: string, to: string, scope: Set<string>, coords?: Map<string, GeoCoord>) => void;
  /** Rewrite one whole place value, taking a house out of it onto the event's
   *  own ADDR line — what a segment rename cannot do. */
  onRenameValue: (from: string, to: string, addr: string, coords?: Map<string, GeoCoord>) => void;
  /** Write a position onto every event at this row's place+address pairs. The
   *  row is one written value, so the pair-keyed write is the exact one: a
   *  settlement's own position never reaches the houses under it, which hold
   *  their own. */
  onApplyAddressCoords: (assignments: Map<string, GeoCoord>) => number;
  /** Take that position away again — the panel's *Clear*. */
  onClearPlaceCoords: (pairs: Set<string>) => number;
  /** Rebuild the tree after either of them wrote. */
  onCoordChange: () => void;
  /** The file's own places, for the rename box's completions. */
  placeSug: PlaceSuggestions;
  /** And the place+address pairs it writes, for the split's two fields. */
  placeCombos: { place: string; addr: string }[];
  /** Every coordinate the file carries — the faint dots on the row's map, where
   *  the family cluster is what tells two same-named places apart. */
  fileCoords: FileCoord[];
  /** The names sitting beside this one under the same parent — what a rename
   *  of this node may complete to, and what makes it a merge. */
  siblings: string[];
  /** Every level's sibling names, keyed by parent path, for the children. */
  siblingNames: Map<string, string[]>;
}) {
  const { t } = useTranslation();
  const lookup = usePlaceLookup();
  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  /** A register offer picked in the box: its text is in the draft, and its
   *  coordinate rides along on apply. Kept with the text it belongs to, so
   *  editing the draft afterwards drops the coordinate rather than writing one
   *  that describes a different place — the rule both geocoding rename boxes
   *  follow. */
  const [renamePick, setRenamePick] = useState<{ text: string; coord: GeoCoord } | null>(null);
  /** The house to take out of the value while renaming it — see {@link splitValue}. */
  const [renameAddrDraft, setRenameAddrDraft] = useState("");
  const debouncedRename = useDebounced(renameValue, 250);
  /** The row's coordinate panel — the one the geocoding lists and the Edit
   *  rows open. Per-row state, so the panel belongs to the coordinate that
   *  opened it. */
  const [coordOpen, setCoordOpen] = useState(false);
  /** The records written at exactly this place, listed only when asked for:
   *  opening a place is about the places under it, not about its hundreds of
   *  people. */
  const [peopleOpen, setPeopleOpen] = useState(false);

  const spots = node.coords?.length ? node.coords : undefined;
  /** The file puts this place in more than one spot — one of them is wrong. */
  const disputed = (spots?.length ?? 0) > 1;

  /** The records under this row — what a rename is scoped to, and what its
   *  preview counts. Only for the row being edited: it walks the whole subtree,
   *  and every row on screen paying that on every rebuild is what made a rename
   *  of one value feel like work on the whole file. */
  const nodeScope = useMemo(() => (editing ? collectNodeUseIds(node) : EMPTY_SCOPE), [editing, node]);

  /**
   * The place and address this row is, as the file writes them — what the
   * coordinate panel looks the row up by, and what its pins are labelled with.
   *
   * Read off a record that sits exactly here, so they carry the file's own
   * spelling and separators. A node that only holds children has no record of
   * its own, and no position to write: it offers no panel at all.
   */
  const placeValue = node.uses[0]?.plac.trim() ?? "";
  const addrValue = node.uses[0]?.addr?.trim() ?? "";
  /** The two together, as the row reads: what the pin standing on this position
   *  is called. */
  const pinValue = addrValue ? `${placeValue} — ${addrValue}` : placeValue;

  /**
   * The one whole `PLAC` value this row stands for, where it stands for one.
   *
   * A rename here rewrites a *segment* wherever it appears under this row — but
   * taking a house out of a value onto the event's own `ADDR` line is not a
   * segment's business: it rewrites the whole value, so it can only be offered
   * where the row is one. Every record under this row must write the same
   * value, which is exactly the case the split is wanted for — a value naming
   * no country at all, "?/Grosova ulica 18", where the street is an address in
   * a place the file has never named.
   *
   * The row's own name need not be that value: a value carrying a house number
   * hangs the house off the locality as a level of its own, so the place row
   * above it stands for the whole thing just the same.
   */
  const splitValue = useMemo(() => {
    if (!editing || node.isAddress) return undefined;
    let only: string | undefined;
    // Stops at the second value rather than reading the subtree out: a country
    // row holds thousands, and this runs per row on screen.
    const walk = (n: PlaceNode): boolean => {
      for (const use of n.uses) {
        const value = use.plac.trim();
        if (only === undefined) only = value;
        else if (only !== value) return false;
      }
      return n.children.every(walk);
    };
    return walk(node) ? only : undefined;
  }, [editing, node]);

  /**
   * Every place+address pair written at exactly this node — what a position
   * picked here is written onto, and taken back off.
   *
   * All of them, not the first: one node is one *place*, and a file spells its
   * places more than one way ("Kranj, Slovenija" and "Kranj,Slovenija" are one
   * row of this tree and two values in the file). Pair-keyed, so a settlement's
   * position reaches the events written at the settlement and never the houses
   * under it, which are rows of their own and hold their own.
   *
   * Worked out when something is written rather than held for every row: what
   * decides whether the row offers a position at all is simply whether it has
   * records, and building a set per row per rebuild is a cost the reader pays
   * for scrolling.
   */
  const coordKeys = useCallback(() => {
    const keys = new Set<string>();
    for (const use of node.uses) {
      const place = use.plac.trim();
      if (place) keys.add(placeAddrKey(place, use.addr?.trim() ?? ""));
    }
    return keys;
  }, [node.uses]);

  /** Write one position onto every record this row stands for, and rebuild the
   *  tree so the row reads back what the file now says. */
  const takeCoord = (coord: GeoCoord) => {
    const keys = coordKeys();
    if (!keys.size) return;
    onApplyAddressCoords(new Map([...keys].map((key) => [key, coord])));
    onCoordChange();
  };
  const dropCoord = () => {
    const keys = coordKeys();
    if (!keys.size) return;
    onClearPlaceCoords(keys);
    onCoordChange();
  };

  /** The triangle is about the places under this one; the people written at
   *  exactly this place are the count's business, opened on their own. */
  const hasKids = node.children.length > 0;
  const hasUses = node.uses.length > 0;
  const open = isOpen(path);
  const isSynthetic = node.name === UNSPECIFIED || node.name === UNSPECIFIED_PLACE;
  const name =
    node.name === UNSPECIFIED
      ? t("tools.places.unspecified")
      : node.name === UNSPECIFIED_PLACE
        ? t("tools.places.unspecifiedPlace")
        : node.name;
  const code = depth === 0 && !isSynthetic ? countryCodeOfName(node.name) : undefined;
  const flag = code ? flagEmoji(code) : undefined;
  const labelNode = flag ? <>{flag} {name}</> : name;

  /** The spots the file writes for this place besides the prevailing one, as
   *  the panel's numbered answers: each says how many records put the place
   *  there, which is what a choice between them is made on. */
  const rivalSpots = useMemo(
    () =>
      disputed
        ? spots!.slice(1).map((spot) => ({
            coord: spot.coord,
            label: name,
            detail: t("tools.places.coord.spotUses", { count: spot.n }),
          }))
        : undefined,
    [disputed, spots, name, t],
  );

  // Compute rename preview whenever the value differs from the current name.
  const preview = useMemo((): PlaceRenamePreview | null => {
    const target = debouncedRename.trim();
    if (!editing || target === node.name) return null;
    return previewPlaceRename(dataset, node.name, target, nodeScope);
  }, [editing, debouncedRename, node.name, dataset, nodeScope]);

  /**
   * What the box completes from: the names beside this one first — renaming to
   * one of those is the merge the button then offers — and behind them every
   * place the file already writes. The sibling list alone is no help at all
   * where the siblings are the problem: under *Unspecified country* they are
   * seventy values as unplaced as this one, and what such a row wants is one of
   * the places the file writes properly, or a register's answer below them.
   */
  const renameSuggestions = useMemo(() => {
    if (!editing) return EMPTY_SUGGESTIONS;
    const own = siblings.filter((s) => s !== node.name);
    const seen = new Set(own.map((s) => s.toLowerCase()));
    return [...own, ...placeSug.placeSuggestions.filter((p) => p !== node.name && !seen.has(p.toLowerCase()))];
  }, [editing, siblings, node.name, placeSug.placeSuggestions]);

  /**
   * A register's answer picked in the box. Its whole chain becomes the new name
   * — which is what places a value the file wrote as a bare "Kokrica" under the
   * country it belongs to — and the house it names goes to the address field,
   * where the row can take a house out of its value at all. A house row takes
   * the register's spelling of the house itself, since that is the segment it
   * renames.
   */
  const pickProposal = (proposal: PlaceProposal) => {
    if (splitValue) {
      setRenameValue(proposal.plac.trim());
      setRenameAddrDraft(proposal.addr?.trim() ?? "");
      setRenamePick({ text: proposal.plac.trim(), coord: proposal.coord });
      return;
    }
    const text = (node.isAddress && addrValue ? (proposal.addr ?? proposal.plac) : proposal.plac).trim();
    setRenameValue(text);
    setRenamePick({ text, coord: proposal.coord });
  };

  function openEdit() {
    setRenameValue(node.name);
    setRenameAddrDraft("");
    setRenamePick(null);
    setEditing(true);
  }

  function handleApply() {
    const target = renameValue.trim();
    const addrTarget = renameAddrDraft.trim();
    if (applyDisabled) return;
    // The coordinate the offer brought, written onto what the rename makes of
    // this row's values — the register answered for the place it named, and
    // that is the value the records now carry. Only where the row has none of
    // its own: a spelling corrected from the register must not quietly move a
    // position that was already reviewed, which the panel beside it is for.
    const picked = renamePick && renamePick.text === target && !spots ? renamePick : null;
    if (addrTarget && splitValue) {
      // A house taken out of the value: the whole value is rewritten and the
      // house written on the event's own ADDR line, which is not something a
      // segment rename can do. The row's coordinate belongs to that pair now.
      // Handed over rather than written here, so the rename and the position
      // land before the tree is rebuilt — once, not once each.
      onRenameValue(
        splitValue,
        target,
        addrTarget,
        picked ? new Map([[placeAddrKey(target, addrTarget), picked.coord]]) : undefined,
      );
    } else {
      let renamed: Map<string, GeoCoord> | undefined;
      if (picked) {
        const renamedValue = (text: string) => (text ? (renameInValue(text, node.name, target) ?? text) : text);
        renamed = new Map();
        for (const key of coordKeys()) {
          const [place, addr] = key.split("\0");
          renamed.set(placeAddrKey(renamedValue(place), renamedValue(addr)), picked.coord);
        }
      }
      onRename(node.name, target, nodeScope, renamed);
    }
    setEditing(false);
    setRenameValue("");
    setRenameAddrDraft("");
    setRenamePick(null);
  }

  const targetTrimmed = renameValue.trim();
  // A house to move out is a change of its own, so the name standing as it is
  // no longer means there is nothing to do.
  const applyDisabled = targetTrimmed === node.name && !(renameAddrDraft.trim() && splitValue);
  // "Merge" when the target is a name this level already has — the editor says
  // "Delete level" for an emptied field on its own account.
  const isMerge = !applyDisabled && !!targetTrimmed && siblings.includes(targetTrimmed);

  return (
    <li className={node.isAddress ? "tools-tree-node tools-tree-addr" : "tools-tree-node"}>
      <div className="tools-tree-row">
        {hasKids ? (
          <button
            className={`tools-pair-toggle ${open ? "open" : ""}`}
            onClick={() => toggle(node, path)}
            aria-expanded={open}
          >
            ▶
          </button>
        ) : (
          <span className="tools-tree-bullet">·</span>
        )}
        <span
          className={`tools-tree-label${hasKids ? " clickable" : ""}${depth === 0 ? " lead" : ""}`}
          onClick={hasKids ? () => toggle(node, path) : undefined}
        >
          {labelNode}
        </span>
        {/* The rename mark sits directly beside the name it rewrites — the same
            spot the geocode place rows and the address rows put it in. */}
        {!isSynthetic && !editing && (
          <button
            className="tools-place-edit-btn"
            onClick={openEdit}
            title={t("tools.places.rename.open")}
          >
            ✎
          </button>
        )}
        {editing && (
          <button
            className="tools-place-edit-btn tools-place-edit-cancel"
            onClick={() => setEditing(false)}
            title={t("tools.places.rename.cancel")}
          >
            ✕
          </button>
        )}
        {/* The count is the handle for the people: the triangle opens the places
            under this one, this opens the records written at exactly this one —
            the same division the geocode place rows make. */}
        {hasUses ? (
          <button
            className="tools-chip-count tools-count-toggle"
            aria-pressed={peopleOpen}
            title={t(hasKids ? "tools.places.peopleToggleSplit" : "tools.places.peopleToggle", {
              count: node.uses.length,
              total: node.count,
            })}
            onClick={() => setPeopleOpen((v) => !v)}
          >
            {/* Two numbers wherever they mean different things: what clicking
                opens — the records written at exactly this place — and what the
                place holds with everything under it. One number said 168 and
                then listed 24, and the reader was left to work out which of the
                two it had meant. Both in the same weight: they are two counts of
                the same kind of thing, and dimming one made it read as an aside
                rather than as the total it is. A leaf has no such gap and keeps
                one number. */}
            {hasKids ? `${node.uses.length} / ${node.count}` : node.count}
          </button>
        ) : (
          <span className="tools-chip-count">{node.count}</span>
        )}
        {/* The position this place holds — and the way to change it: the same
            coordinate panel the geocoding lists and the Edit rows open, with
            its map, its register and OpenStreetMap searches and its manual
            entry, where the row used to open a map that could only be looked
            at. Only on a row with records of its own: a level that merely
            holds other places has nothing to write a position onto, and the
            houses under it keep their own. */}
        {hasUses && (
          <span className="tools-place-coord-wrap">
            {spots ? (
              <button
                type="button"
                className="tools-tree-meta gm-data gm-coord gm-coord--set tools-place-coord"
                aria-expanded={coordOpen}
                title={t(disputed ? "tools.places.coord.disputed" : "tools.places.coord")}
                onClick={() => setCoordOpen((v) => !v)}
              >
                {formatCoord(spots[0].coord)}
                {disputed && <span className="tools-place-coord-warn">⚠ {t("tools.places.coord.spots", { count: spots.length })}</span>}
              </button>
            ) : (
              /* A place the file never geocoded: the pin is the faint mark the
                 ✎ beside the name is, present on every row and coming up to
                 full strength under the pointer, so a tree of unplaced villages
                 reads as a list of places and not as a column of pins. */
              <button
                type="button"
                className="tools-place-edit-btn tools-place-coord-add"
                aria-expanded={coordOpen}
                title={t("tools.places.coord.add")}
                onClick={() => setCoordOpen((v) => !v)}
              >
                <PinIcon />
              </button>
            )}
            <EventCoordPicker
              place={placeValue}
              address={addrValue}
              coord={spots?.[0].coord}
              title={name}
              // The place as the file writes it, so the pin standing on the
              // position says which place is pinned there — "current" is what
              // an event's own panel calls it, and a tree row is not an event.
              currentLabel={pinValue}
              hideTrigger
              open={coordOpen}
              onOpenChange={setCoordOpen}
              // The file's other spots for this very place, numbered as answers
              // to choose between: picking one writes it over every record the
              // row stands for, which is what settles the ⚠ above.
              {...(rivalSpots ? { candidates: rivalSpots } : {})}
              context={fileCoords}
              // A row here can be a country, and one pin at house zoom would
              // fill the map with a single street of it.
              fitMaxZoom={node.isAddress ? HOUSE_ZOOM : TOWN_ZOOM}
              onPick={takeCoord}
              onClear={dropCoord}
            />
          </span>
        )}
      </div>

      {editing && (
        // The rename box every list of these tools opens — its completions, its
        // register lookup and its Enter/Escape contract. What is particular to
        // the tree is what it says on the button (a target standing beside this
        // name is a merge, an emptied field deletes the level) and the count of
        // records it would reach, which sits between the field and the button.
        <RenameEditor
          value={renameValue}
          suggestions={renameSuggestions}
          canonical={placeSug.placeCanonical}
          {...(splitValue
            ? {
                combos: placeCombos,
                onPickCombo: (place: string, addr: string) => {
                  setRenameValue(place);
                  setRenameAddrDraft(addr);
                  setRenamePick(null);
                },
              }
            : {})}
          placeholder={t("tools.places.rename.placeholder")}
          applyDisabled={applyDisabled}
          applyLabel={isMerge ? t("tools.places.rename.merge") : t("tools.places.rename.apply")}
          onChange={(next) => {
            setRenameValue(next);
            setRenamePick(null);
          }}
          onApply={handleApply}
          onCancel={() => setEditing(false)}
          onRemove={handleApply}
          removeLabel={t("tools.places.rename.delete")}
          onPickProposal={pickProposal}
          // A house row asks the address registers about a house *at* its
          // place; everything else asks the place registers about a place.
          // Online lookups off still leaves the imported gazetteer answering
          // places — but no register of houses, so a house row says why
          // instead of offering a search that cannot answer.
          {...(node.isAddress && addrValue
            ? {
                ...(lookup?.online ? { onLookup: (query: string) => lookup.searchAddress(placeValue, query) } : {}),
                ...(lookup && !lookup.online ? { lookupNote: t("tools.geocode.downloadNeedsOptIn") } : {}),
              }
            : {
                ...(lookup ? { onLookup: (query: string) => lookup.search(query) } : {}),
                ...(lookup && !lookup.online ? { lookupNote: t("event.place.lookup.offlineOnly") } : {}),
              })}
        >
          {/* The house to take out of the value, where the row stands for one
              whole value: "?/Grosova ulica 18" is a street in a place the file
              never named, and correcting it means saying both — the place it is
              in, and that the street is an address. */}
          {splitValue && (
            <AddressSplitField
              place={renameValue}
              value={renameAddrDraft}
              placeSug={placeSug}
              placeCombos={placeCombos}
              onChange={(next) => {
                setRenameAddrDraft(next);
                setRenamePick(null);
              }}
              onPickCombo={(place, addr) => {
                setRenameValue(place);
                setRenameAddrDraft(addr);
                setRenamePick(null);
              }}
              onPickProposal={(proposal) => {
                // The offer answers the *address*, so its own place comes with
                // it: what the register found is a house in a settlement, and
                // taking half of it would leave the two describing different
                // places.
                setRenameValue(proposal.plac.trim());
                setRenameAddrDraft(proposal.addr?.trim() ?? "");
                setRenamePick({ text: proposal.plac.trim(), coord: proposal.coord });
              }}
            />
          )}
          {preview && !renameAddrDraft.trim() && (
            <span className="tools-place-rename-hint">
              {preview.affectedCount > 0
                ? t("tools.places.rename.count", { count: preview.affectedCount })
                : t("tools.places.rename.noMatch")}
            </span>
          )}
        </RenameEditor>
      )}

      {/* Directly under the count that asked for it, above the sub-places, so
          the click and its list stay together however deep the tree is open. */}
      {peopleOpen && hasUses && (
        <div className="tools-tree-children">
          <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
        </div>
      )}

      {open && hasKids && (
        <div className="tools-tree-children">
          <ul className="tools-tree">
            {node.children.map((child) => (
              <PlaceTreeRow
                key={child.name}
                dataset={dataset}
                node={child}
                path={`${path}/${child.name}`}
                depth={depth + 1}
                isOpen={isOpen}
                toggle={toggle}
                onNavigate={onNavigate}
                onRename={onRename}
                onRenameValue={onRenameValue}
                onApplyAddressCoords={onApplyAddressCoords}
                onClearPlaceCoords={onClearPlaceCoords}
                onCoordChange={onCoordChange}
                placeSug={placeSug}
                placeCombos={placeCombos}
                fileCoords={fileCoords}
                siblings={siblingNames.get(path) ?? node.children.map((c) => c.name)}
                siblingNames={siblingNames}
              />
            ))}
          </ul>
          <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
        </div>
      )}
    </li>
  );
}
