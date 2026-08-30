import { useEffect, useMemo, useState } from "react";
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
import { ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";
import { ToolSummary } from "./ToolSummary";
import { formatCoord } from "../../geo/points";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import { PlaceLookupProvider, usePlaceLookup } from "../edit/PlaceLookupContext";
import { usePlaceFields } from "../edit/usePlaceFields";
import type { PlaceSuggestions } from "../edit/placeSuggestions";
import { renameInValue } from "../../tools/placeEdit";
import type { PlaceProposal } from "../../geo/placeProposal";
import { PinIcon } from "../icons/PinIcon";

/** How far the row's map opens on a single coordinate: close enough to read
 *  the town and its streets, since the question a place's map answers is
 *  "which town is this pinned in", not "which country". */
const TOWN_ZOOM = 13;

/** An address row's map answers a closer question — "which building is this" —
 *  so it opens at house level, the zoom the coordinate panel fits to
 *  everywhere else. */
const HOUSE_ZOOM = 17;

/** What {@link buildPlaceTree} joins a place value and its ADDR with, so a
 *  row's own record can be read back as the pair the file writes. */
const USE_SEPARATOR = " — ";

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

  function handleRename(from: string, to: string, scope: Set<string>) {
    // Capture the path of `from` in the current tree before rebuild so we can
    // derive the correct destination path (avoids opening the wrong "Wayne" in
    // a different state when multiple nodes share the target name).
    let fromPath: string | null = null;
    if (tree) {
      const findFrom = (node: PlaceNode, path: string): boolean => {
        if (node.name === from) { fromPath = path; return true; }
        for (const child of node.children) {
          if (findFrom(child, `${path}/${child.name}`)) return true;
        }
        return false;
      };
      for (const root of tree.roots) { if (findFrom(root, root.name)) break; }
    }

    onApplyPlaceRename(from, to, scope);
    const newTree = buildPlaceTree(dataset);
    setTree(newTree);

    // Build the expected path: substitute `to` for `from`, or remove the segment when deleting.
    const expectedPath = fromPath
      ? to
        ? (fromPath as string).split("/").map(s => s === from ? to : s).join("/")
        : (fromPath as string).split("/").filter(s => s !== from).join("/")
      : null;

    const toOpen = new Set<string>();
    if (expectedPath) {
      const parts = expectedPath.split("/");
      for (let i = 1; i <= parts.length; i++) toOpen.add(parts.slice(0, i).join("/"));
    }
    setOpen(toOpen);
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
  const { placeSug, lookup: placeLookup, fileCoords } = usePlaceFields(dataset);

  // What the geocode tool has to offer, as the chip's two badges: distinct
  // place names still missing coordinates, and addresses a register lookup
  // could pin to their house. Both recomputed with the tree (same trigger:
  // dataset change / re-entry), since the tool works on either kind and a file
  // can be done with one and full of the other.
  const geocodePending = useMemo(() => (tree ? countGeocodePending(dataset) : 0), [dataset, tree]);
  // Placed rows ride along in the scan (the review list can show them back);
  // pending work is only what still lacks a position of its own.
  const addressPending = useMemo(
    () => (tree ? (derivations?.addressRows() ?? scanAddresses(dataset)).filter((r) => !r.placed).length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, tree],
  );

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
              onApplyAddressCoords={onApplyAddressCoords}
              onClearPlaceCoords={onClearPlaceCoords}
              onCoordChange={handleCoordChange}
              placeSug={placeSug}
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
  onApplyAddressCoords,
  onClearPlaceCoords,
  onCoordChange,
  placeSug,
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
  onRename: (from: string, to: string, scope: Set<string>) => void;
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

  const nodeScope = useMemo(() => collectNodeUseIds(node), [node]);

  /**
   * The place and address this row is, as the file writes them — what the
   * coordinate panel looks the row up by, and what its pins are labelled with.
   *
   * Both are read off a record that sits exactly here, so they carry the file's
   * own spelling and separators; an address row's record joins the pair with
   * {@link USE_SEPARATOR}, which is split back apart here because the registers
   * are asked about a house *at* a place, not about the two run together. A
   * node that only holds children has no record of its own, and no position to
   * write: it offers no panel at all.
   */
  const { placeValue, addrValue } = useMemo(() => {
    const raw = node.uses[0]?.raw?.trim() ?? "";
    const at = raw.indexOf(USE_SEPARATOR);
    if (at >= 0) return { placeValue: raw.slice(0, at), addrValue: raw.slice(at + USE_SEPARATOR.length) };
    return { placeValue: raw, addrValue: "" };
  }, [node.uses]);
  /** The two run together again, as the row's own record writes them: what the
   *  pin standing on this position is called. */
  const pinValue = addrValue ? `${placeValue}${USE_SEPARATOR}${addrValue}` : placeValue;

  /**
   * Every place+address pair written at exactly this node — what a position
   * picked here is written onto, and taken back off.
   *
   * All of them, not the first: one node is one *place*, and a file spells its
   * places more than one way ("Kranj, Slovenija" and "Kranj,Slovenija" are one
   * row of this tree and two values in the file). Pair-keyed, so a settlement's
   * position reaches the events written at the settlement and never the houses
   * under it, which are rows of their own and hold their own.
   */
  const coordKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const use of node.uses) {
      const raw = use.raw.trim();
      const at = raw.indexOf(USE_SEPARATOR);
      const place = at >= 0 ? raw.slice(0, at) : raw;
      const addr = at >= 0 ? raw.slice(at + USE_SEPARATOR.length) : "";
      if (place) keys.add(placeAddrKey(place, addr));
    }
    return keys;
  }, [node.uses]);

  /** Write one position onto every record this row stands for, and rebuild the
   *  tree so the row reads back what the file now says. */
  const takeCoord = (coord: GeoCoord) => {
    if (!coordKeys.size) return;
    onApplyAddressCoords(new Map([...coordKeys].map((key) => [key, coord])));
    onCoordChange();
  };
  const dropCoord = () => {
    if (!coordKeys.size) return;
    onClearPlaceCoords(new Set(coordKeys));
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
    const own = siblings.filter((s) => s !== node.name);
    const seen = new Set(own.map((s) => s.toLowerCase()));
    return [...own, ...placeSug.placeSuggestions.filter((p) => p !== node.name && !seen.has(p.toLowerCase()))];
  }, [siblings, node.name, placeSug.placeSuggestions]);

  /**
   * A register's answer picked in the box. Its whole chain becomes the new name
   * — which is what places a value the file wrote as a bare "Kokrica" under the
   * country it belongs to — and a house row takes the register's spelling of
   * the house instead, since that is the segment it renames.
   */
  const pickProposal = (proposal: PlaceProposal) => {
    const text = (node.isAddress && addrValue ? (proposal.addr ?? proposal.plac) : proposal.plac).trim();
    setRenameValue(text);
    setRenamePick({ text, coord: proposal.coord });
  };

  function openEdit() {
    setRenameValue(node.name);
    setRenamePick(null);
    setEditing(true);
  }

  function handleApply() {
    const target = renameValue.trim();
    if (target === node.name) return;
    // The coordinate the offer brought, written onto what the rename makes of
    // this row's values — the register answered for the place it named, and
    // that is the value the records now carry. Only where the row has none of
    // its own: a spelling corrected from the register must not quietly move a
    // position that was already reviewed, which the panel beside it is for.
    const picked = renamePick && renamePick.text === target && !spots ? renamePick : null;
    onRename(node.name, target, nodeScope);
    if (picked) {
      const renamedValue = (text: string) => (text ? (renameInValue(text, node.name, target) ?? text) : text);
      const renamed = new Map<string, GeoCoord>();
      for (const key of coordKeys) {
        const [place, addr] = key.split("\0");
        renamed.set(placeAddrKey(renamedValue(place), renamedValue(addr)), picked.coord);
      }
      onApplyAddressCoords(renamed);
      onCoordChange();
    }
    setEditing(false);
    setRenameValue("");
    setRenamePick(null);
  }

  const targetTrimmed = renameValue.trim();
  const applyDisabled = targetTrimmed === node.name;
  // Show "Delete" when target is cleared; "Merge" when it already exists.
  const isDelete = !applyDisabled && targetTrimmed === "";
  const isMerge = !applyDisabled && !isDelete && siblings.includes(targetTrimmed);

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
        {coordKeys.size > 0 && (
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
        <div
          className="tools-place-rename"
          onKeyDown={(e) => {
            // Enter on a highlighted suggestion, and Escape with the dropdown
            // open, belong to the autocomplete (defaultPrevented); the next
            // press is the editor's — same contract as the address rename row.
            if (e.key === "Enter" && !e.defaultPrevented && !applyDisabled) handleApply();
            if (e.key === "Escape" && !e.defaultPrevented) setEditing(false);
          }}
        >
          {/* The app's own dropdown, not a native <datalist>: the browser
              renders that one in system chrome, which ignores the theme (a
              dark popup over the light app) and cannot be styled at all. */}
          <PlaceAutocomplete
            value={renameValue}
            suggestions={renameSuggestions}
            canonical={placeSug.placeCanonical}
            isDirty={false}
            className="tools-place-rename-input"
            wrapClassName="tools-place-rename-auto"
            placeholder={t("tools.places.rename.placeholder")}
            autoFocus
            // A rename may be exactly a casing fix, which the canonical map
            // would otherwise undo — as on the address rename row.
            preserveCase
            onChange={(next) => {
              setRenameValue(next);
              setRenamePick(null);
            }}
            onCommit={setRenameValue}
            onClear={() => {
              setRenameValue("");
              setRenamePick(null);
            }}
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
          />
          {preview && (
            <span className="tools-place-rename-hint">
              {preview.affectedCount > 0
                ? t("tools.places.rename.count", { count: preview.affectedCount })
                : t("tools.places.rename.noMatch")}
            </span>
          )}
          <button
            className="nav-btn primary tools-place-rename-apply"
            onClick={handleApply}
            disabled={applyDisabled}
          >
            {isDelete ? t("tools.places.rename.delete") : isMerge ? t("tools.places.rename.merge") : t("tools.places.rename.apply")}
          </button>
        </div>
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
                onApplyAddressCoords={onApplyAddressCoords}
                onClearPlaceCoords={onClearPlaceCoords}
                onCoordChange={onCoordChange}
                placeSug={placeSug}
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
