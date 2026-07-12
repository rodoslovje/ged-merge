import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { buildPlaceTree, collectNodeUseIds, type PlaceNode, type PlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "../../tools/places";
import { collectPlaceSegments, previewPlaceRename, type PlaceRenamePreview } from "../../tools/placeEdit";
import { countryCode } from "../../gedcom/countryCode";
import { ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";

/** Prune a place node to those whose name matches `q` (already lower-cased)
 * anywhere in the subtree. A node matching by name keeps its whole subtree;
 * otherwise only matching descendant branches are retained. Paths of nodes that
 * survive solely as ancestors of a match are collected in `autoOpen` so they can
 * be expanded down to (but not past) the matching entries. */
function filterPlaceNode(node: PlaceNode, q: string, path: string, autoOpen: Set<string>): PlaceNode | null {
  if (node.name.toLowerCase().includes(q)) return node;
  const children: PlaceNode[] = [];
  for (const child of node.children) {
    const kept = filterPlaceNode(child, q, `${path}/${child.name}`, autoOpen);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  autoOpen.add(path);
  return { ...node, children };
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
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

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

  // All distinct segments for rename autocomplete — recomputed whenever the tree rebuilds.
  const allSegments = useMemo(() => tree ? collectPlaceSegments(dataset) : [], [tree, dataset]);

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

  if (!tree) return <ToolsLoading label={t("tools.running")} />;

  return (
    <>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <p className="tools-summary">
          {t("tools.places.summary", { countries: tree.countryCount, distinct: tree.distinctCount, uses: tree.totalUses })}
        </p>
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
              allSegments={allSegments}
            />
          ))}
        </ul>
      )}
    </>
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
  allSegments,
}: {
  dataset: Dataset;
  node: PlaceNode;
  path: string;
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (node: PlaceNode, path: string) => void;
  onNavigate: (id: string) => void;
  onRename: (from: string, to: string, scope: Set<string>) => void;
  allSegments: string[];
}) {
  const { t } = useTranslation();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const debouncedRename = useDebounced(renameValue, 250);

  const nodeScope = useMemo(() => collectNodeUseIds(node), [node]);

  const hasChildren = node.children.length > 0 || node.uses.length > 0;
  const open = isOpen(path);
  const isSynthetic = node.name === UNSPECIFIED || node.name === UNSPECIFIED_PLACE;
  const name =
    node.name === UNSPECIFIED
      ? t("tools.places.unspecified")
      : node.name === UNSPECIFIED_PLACE
        ? t("tools.places.unspecifiedPlace")
        : node.name;
  const code = depth === 0 && !isSynthetic ? countryCode(node.name) : undefined;
  const flag = code ? [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("") : undefined;
  const labelNode = flag ? <>{flag} {name}</> : name;

  // Compute rename preview whenever the value differs from the current name.
  const preview = useMemo((): PlaceRenamePreview | null => {
    const target = debouncedRename.trim();
    if (!editing || target === node.name) return null;
    return previewPlaceRename(dataset, node.name, target, nodeScope);
  }, [editing, debouncedRename, node.name, dataset, nodeScope]);

  function openEdit() {
    setRenameValue(node.name);
    setEditing(true);
  }

  function handleApply() {
    const target = renameValue.trim();
    if (target === node.name) return;
    onRename(node.name, target, nodeScope);
    setEditing(false);
    setRenameValue("");
  }

  const datalistId = `place-segs-${uid}`;
  const targetTrimmed = renameValue.trim();
  const applyDisabled = targetTrimmed === node.name;
  // Show "Delete" when target is cleared; "Merge" when it already exists.
  const isDelete = !applyDisabled && targetTrimmed === "";
  const isMerge = !applyDisabled && !isDelete && allSegments.includes(targetTrimmed);

  return (
    <li className={node.isAddress ? "tools-tree-node tools-tree-addr" : "tools-tree-node"}>
      <div className="tools-tree-row">
        {hasChildren ? (
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
          className={`tools-tree-label${hasChildren ? " clickable" : ""}${depth === 0 ? " lead" : ""}`}
          onClick={hasChildren ? () => toggle(node, path) : undefined}
        >
          {labelNode}
        </span>
        <span className="tools-chip-count">{node.count}</span>
        {!isSynthetic && !editing && (
          <button
            className="tools-place-edit-btn"
            onClick={openEdit}
            title={t("tools.places.rename.open")}
          >
            ✏︎
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
      </div>

      {editing && (
        <div className="tools-place-rename">
          <datalist id={datalistId}>
            {allSegments.map((s) => <option key={s} value={s} />)}
          </datalist>
          <input
            type="text"
            className="tools-place-rename-input"
            value={renameValue}
            list={datalistId}
            autoFocus
            placeholder={t("tools.places.rename.placeholder")}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !applyDisabled) handleApply();
              if (e.key === "Escape") setEditing(false);
            }}
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

      {open && hasChildren && (
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
                allSegments={allSegments}
              />
            ))}
          </ul>
          <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
        </div>
      )}
    </li>
  );
}
