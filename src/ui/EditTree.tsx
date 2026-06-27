import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildCompareTree, countTreePeople, type TreeMode } from "../tree/compareTree";
import {
  PAD,
  flatten,
  layout,
  type Placed,
} from "../tree/treeLayout";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { TreeMinimap } from "./TreeMinimap";
import { kinshipLabel } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { decisionStatusByMasterId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { sexClass } from "./sex";
import { TreeNodeBox } from "./TreeNodeBox";
import { TreeNodePanel } from "./TreeNodePanel";
import { MapIcon } from "./icons/MapIcon";
import { diagramSlug, exportCanvasSvg } from "./exportSvg";

// Color for unmodified nodes (master pine green) and modified (amber/minor).
const COLOR_NORMAL = "var(--node-master)";
const COLOR_MODIFIED = "var(--node-minor)";

// Empty compare-side dataset — the tree builder needs a valid Dataset object
// but won't find any incoming individuals since all Maps are empty.
const EMPTY_DS = {
  version: "unknown" as const,
  charset: "UTF-8" as const,
  individuals: new Map(),
  families: new Map(),
  records: [],
  warnings: [],
  eol: "\r\n",
  finalNewline: true,
  chanCreaUsage: { recordChan: false, recordCrea: false, eventChan: false, eventCrea: false },
} as Dataset;

const EMPTY_MAPS = {
  masterToCompare: new Map<string, string>(),
  compareToMaster: new Map<string, string>(),
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  masterDs: Dataset;
  rootId: string;
  homeId?: string;
  changedPersonIds: Set<string>;
  /** Merge decisions, so confirmed/rejected/deferred matches show the same badge here as in the Compare Tree. */
  decisions?: Map<string, CandidateDecision>;
  onBack: () => void;
}

export function EditTree({ masterDs, rootId, homeId, changedPersonIds, decisions, onBack }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TreeMode>("ancestors");
  const [currentRootId, setCurrentRootId] = useState(rootId);
  const [mapOpen, setMapOpen] = useState(true);

  const rootPerson = masterDs.individuals.get(currentRootId);

  const tree = useMemo(
    () => rootPerson
      ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, mode)
      : undefined,
    [t, rootPerson, masterDs, mode],
  );

  const laid = useMemo(() => (tree ? layout(tree) : undefined), [tree]);
  const flat = useMemo(() => (laid ? flatten(laid.root) : undefined), [laid]);

  // Ancestor / descendant head-counts for both directions, shown on the mode
  // buttons so the user can tell at a glance whether either way is worth
  // opening. Built independently of the current mode (memoized on the root), so
  // switching modes doesn't recompute them.
  const peopleCounts = useMemo(() => ({
    ancestors: countTreePeople(rootPerson ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "ancestors") : undefined),
    descendants: countTreePeople(rootPerson ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "descendants") : undefined),
  }), [t, rootPerson, masterDs]);

  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!m.has(n.key)) m.set(n.key, n);
    return m;
  }, [flat]);

  const isModified = useCallback(
    (n: Placed) => !!n.master && changedPersonIds.has(n.master.id),
    [changedPersonIds],
  );
  const colorOf = useCallback(
    (n: Placed) => isModified(n) ? COLOR_MODIFIED : COLOR_NORMAL,
    [isModified],
  );

  const decisionStatusById = useMemo(() => decisionStatusByMasterId(decisions), [decisions]);
  const decisionOf = useCallback(
    (n: Placed): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
      const status = n.master ? decisionStatusById.get(n.master.id) : undefined;
      return status ? { status, letter: t(`status.${status}`).charAt(0) } : undefined;
    },
    [decisionStatusById, t],
  );

  // Viewport, grab-to-pan, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selected, selectNode } =
    useTreeCanvas(laid, nodesByKey);

  // Master-only field rows for the selected person's detail panel; clicking a
  // relative re-roots the tree on them.
  const selectedRows = useMemo(
    () => (selected?.master ? individualFieldRows(t, selected.master, undefined, masterDs) : []),
    [t, selected, masterDs],
  );
  const masterNav = useMemo(
    () => ({
      linkable: (id: string) => masterDs.individuals.has(id),
      onNavigate: (id: string) => { setCurrentRootId(id); setSelectedKey(null); },
    }),
    [masterDs, setSelectedKey],
  );
  const selectedDecision = selected ? decisionOf(selected) : undefined;
  const selectedModified = selected ? isModified(selected) : false;

  // ── Derived counts for legend ─────────────────────────────────────────────

  // "Modified" and "Merged" are independent, overlapping dimensions — a node can
  // carry both an edit and a confirmed merge — so the counts mirror the badges
  // rather than partitioning the total. "Unmodified" is the clean complement:
  // people the save leaves untouched (no edit, no confirmed merge).
  const allNodes = flat?.nodes ?? [];
  const modifiedCount = allNodes.filter((n) => isModified(n)).length;
  const mergedCount = allNodes.filter((n) => decisionOf(n)?.status === "confirmed").length;
  const unmodifiedCount = allNodes.filter(
    (n) => !isModified(n) && decisionOf(n)?.status !== "confirmed",
  ).length;

  // Root person's kinship to the home person, shown in the title.
  const rootKinship = homeId && rootPerson ? kinshipLabel(masterDs, homeId, rootPerson.id, t) : undefined;

  const needsMinimap =
    !!laid && viewport.width > 0 &&
    (laid.width > viewport.width + 1 || laid.height > viewport.height + 1);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn tree-back-btn" onClick={onBack} title={t("edit.tree.back")} aria-label={t("edit.tree.back")}>
          ← <span className="tree-back-label">{t("edit.tree.back")}</span>
        </button>
        <h2 className="tree-title">
          {tree ? (
            <>
              <span className={`tree-title-name ${rootPerson ? sexClass(rootPerson.sex) : ""}`}>
                {tree.name}
              </span>
              {tree.years && <span className="tree-title-years gm-data">{tree.years}</span>}
              <span className="tree-title-break" aria-hidden="true" />
              {rootKinship && <span className="tree-title-kinship">{rootKinship}</span>}
              <span className="tree-title-kind">{t("edit.tree.title")}</span>
            </>
          ) : (
            t("edit.tree.title")
          )}
        </h2>
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasSvg(
            canvasRef.current,
            diagramSlug(tree?.name, "tree"),
            [tree?.name, tree?.years, "—", t("edit.tree.title")].filter(Boolean).join(" "),
          )}
          disabled={!laid}
          title={t("tree.export.tooltip")}
        >
          {t("tree.export")}
        </button>
      </div>

      {/* Mode toggle (left) + legend (right) — same layout as the Compare Tree. */}
      <div className="tree-controls">
        <div className="tree-mode">
          <button className={mode === "ancestors" ? "active" : ""} onClick={() => setMode("ancestors")}>
            {t("tree.ancestors")}
            <span className="tree-mode-count">{peopleCounts.ancestors}</span>
          </button>
          <button className={mode === "descendants" ? "active" : ""} onClick={() => setMode("descendants")}>
            {t("tree.descendants")}
            <span className="tree-mode-count">{peopleCounts.descendants}</span>
          </button>
        </div>
        {/* Legend: confirmed-merge badge + modified / unmodified swatches.
            Merged and Modified overlap, so they don't sum to the total.
            Empty groups are hidden. */}
        <div className="tree-legend">
          {mergedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch confirmed" />
                {t("edit.tree.merged")} ({mergedCount})
              </span>
            </div>
          )}
          {modifiedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch" style={{ background: COLOR_MODIFIED }} />
                {t("edit.tree.modified")} ({modifiedCount})
              </span>
            </div>
          )}
          {unmodifiedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch" style={{ background: COLOR_NORMAL }} />
                {t("edit.tree.unmodified")} ({unmodifiedCount})
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="tree-canvas-wrap">
        <div
          className={`tree-canvas${panning ? " panning" : ""}`}
          ref={canvasRef}
          {...canvasProps}
        >
          {laid && flat ? (
            <svg className="tree-svg" width={laid.width} height={laid.height} role="img">
              <g transform={`translate(${PAD},${PAD})`}>
                {flat.edges.map((e) => (
                  <path
                    key={e.id}
                    className={e.partner ? "tree-edge tree-edge-partner" : "tree-edge"}
                    d={e.d}
                  />
                ))}
                {flat.nodes.map((n) => {
                  const color = colorOf(n);
                  const modified = isModified(n);
                  const dec = decisionOf(n);
                  return (
                    <g
                      key={n.key}
                      transform={`translate(${n.x},${n.y})`}
                      className={`tree-node${n.key === selectedKey ? " selected" : ""}`}
                      onClick={() => selectNode(n.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      <TreeNodeBox
                        name={n.name}
                        years={n.years}
                        sex={n.sex}
                        color={color}
                        kinship={homeId && n.master?.id ? kinshipLabel(masterDs, homeId, n.master.id, t) : undefined}
                        photo={n.master ? { raw: n.master.raw, records: masterDs.records, refCtx: { dataset: masterDs, onNavigate: setCurrentRootId } } : undefined}
                        badgeWidth={(modified ? 22 : 0) + (dec ? 22 : 0)}
                        badges={({ yearsY, textX: tx }) => {
                          // Estimate the years label width (~6.5px/char) so badges sit just past it.
                          const badge1X = tx + (n.years ? n.years.length * 6.5 + 8 : 0) + 7;
                          const modifiedBadgeX = dec ? badge1X + 18 : badge1X;
                          return (
                            <>
                              {dec && (
                                <g className={`tree-node-decision ${dec.status}`} transform={`translate(${badge1X},${yearsY - 4})`}>
                                  <circle r={7} />
                                  <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700}>
                                    {dec.letter}
                                  </text>
                                </g>
                              )}
                              {modified && (
                                <g className="tree-node-decision" transform={`translate(${modifiedBadgeX},${yearsY - 4})`}>
                                  <circle r={7} fill={COLOR_MODIFIED} />
                                  <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700} fill="var(--bg)">
                                    {t("edit.tree.modified").charAt(0)}
                                  </text>
                                </g>
                              )}
                            </>
                          );
                        }}
                      />
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>

        {needsMinimap && laid && flat && (
          mapOpen ? (
            <div className="tree-minimap-box">
              <button
                className="tree-minimap-collapse"
                onClick={() => setMapOpen(false)}
                title={t("tree.minimap.hide")}
                aria-label={t("tree.minimap.hide")}
              >
                ×
              </button>
              <TreeMinimap
                nodes={flat.nodes}
                contentW={laid.width}
                contentH={laid.height}
                viewport={viewport}
                onScrollTo={scrollTo}
                fill={colorOf}
              />
            </div>
          ) : (
            <button
              className="tree-minimap-show"
              onClick={() => setMapOpen(true)}
              title={t("tree.minimap.show")}
              aria-label={t("tree.minimap.show")}
            >
              <MapIcon />
            </button>
          )
        )}

        {selected && selected.master && (
          <TreeNodePanel
            node={selected}
            swatch={colorOf(selected)}
            rows={selectedRows}
            masterPerson={masterNav}
            masterLabel={t("tree.master")}
            singleColumn
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => {
              setCurrentRootId(selected.master!.id);
              setSelectedKey(null);
            }}
            badges={
              selectedDecision || selectedModified ? (
                <>
                  {selectedDecision && (
                    <span className={`status-chip ${selectedDecision.status}`} title={t(`status.${selectedDecision.status}`)}>
                      {t(`status.${selectedDecision.status}`)}
                    </span>
                  )}
                  {selectedModified && <span className="edit-tree-badge">{t("edit.tree.modified")}</span>}
                </>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
