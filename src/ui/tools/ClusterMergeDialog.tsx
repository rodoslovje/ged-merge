import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { xrefLabel } from "../../gedcom/nameDisplay";
import { categorize, DEFAULT_CONFIG } from "../../match/types";
import { membersWithoutDirectPair, type DuplicateCluster } from "../../tools/duplicates";
import {
  clusterRelativeGroups,
  pickClusterSurvivor,
  type ClusterRelativeGroup,
} from "../../tools/mergeCluster";
import { useModalKeyboard } from "../../keyboard/useModalKeyboard";
import { PersonRefLabel } from "../PersonLink";

/**
 * Ask about collapsing a whole duplicate cluster into one record.
 *
 * Three things have to be settled before that is safe, and each is a section of
 * this dialog: **which record survives** (auto-picked, changeable), **which
 * duplicated relatives come along** (unticked by default — merging someone is
 * never a side effect), and **whether the cluster is actually one person**: a
 * member linked in only through a chain of other pairs was never scored against
 * the survivor at all, and the warning says so by name.
 */
export function ClusterMergeDialog({
  dataset,
  cluster,
  onCancel,
  onConfirm,
}: {
  dataset: Dataset;
  cluster: DuplicateCluster;
  onCancel: () => void;
  onConfirm: (survivorId: string, groups: ClusterRelativeGroup[]) => void;
}) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(true, onCancel);
  const [survivorId, setSurvivorId] = useState(
    () => pickClusterSurvivor(dataset, cluster.memberIds) ?? cluster.memberIds[0],
  );
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  // The relatives are read off comparisons against the survivor, so changing
  // the survivor re-derives them (and drops ticks that no longer exist).
  const groups = useMemo(
    () => clusterRelativeGroups(dataset, survivorId, cluster.memberIds, t),
    [dataset, survivorId, cluster.memberIds, t],
  );
  const picked = groups.filter((g) => ticked.has(g.key));
  const indirect = membersWithoutDirectPair(cluster, survivorId);
  const removedCount =
    cluster.memberIds.length - 1 + picked.reduce((n, g) => n + g.memberIds.length - 1, 0);

  const before = groups.filter((g) => g.when === "before");
  const after = groups.filter((g) => g.when === "after");

  function renderGroups(list: ClusterRelativeGroup[], hint: string) {
    if (list.length === 0) return null;
    return (
      <div className="cluster-dialog-related">
        <p className="cluster-dialog-hint">{hint}</p>
        <ul className="cluster-dialog-list">
          {list.map((g) => (
            <li key={g.key}>
              <label className="cluster-dialog-row">
                <input
                  type="checkbox"
                  checked={ticked.has(g.key)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(g.key);
                    else next.delete(g.key);
                    setTicked(next);
                  }}
                />
                <span className={`tools-cat cat-${categorize(Math.round(g.score) / 100, DEFAULT_CONFIG)}`}>
                  {Math.round(g.score)}
                </span>
                <span className="cluster-dialog-name">{g.label}</span>
                <span
                  className="cluster-dialog-meta"
                  title={t("tools.duplicates.cluster.recordIds", {
                    ids: g.memberIds.map(xrefLabel).join(", "),
                  })}
                >
                  {t("tools.duplicates.cluster.records", { count: g.memberIds.length })}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog cluster-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="confirm-dialog-title">
          {t("tools.duplicates.cluster.mergeAllTitle", { count: cluster.memberIds.length })}
        </p>
        <p className="confirm-dialog-body">{t("tools.duplicates.cluster.mergeAllBody")}</p>

        <p className="cluster-dialog-hint">{t("tools.duplicates.cluster.survivorPick")}</p>
        <ul className="cluster-dialog-list">
          {cluster.memberIds.map((id) => (
            <li key={id}>
              <label className="cluster-dialog-row">
                <input
                  type="radio"
                  name="cluster-survivor"
                  checked={id === survivorId}
                  onChange={() => setSurvivorId(id)}
                />
                <span className="cluster-dialog-name">
                  <PersonRefLabel dataset={dataset} id={id} fallback={xrefLabel(id)} forceXref />
                </span>
              </label>
            </li>
          ))}
        </ul>

        {indirect.length > 0 && (
          <p className="cluster-dialog-warning">
            {t("tools.duplicates.cluster.indirectWarning", {
              count: indirect.length,
              ids: indirect.map(xrefLabel).join(", "),
            })}
          </p>
        )}

        {renderGroups(before, t("tools.duplicates.cluster.relatedHint"))}
        {renderGroups(after, t("tools.duplicates.cluster.relatedChildHint"))}

        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t("confirm.cancel")}
          </button>
          <button
            type="button"
            className="confirm-dialog-confirm danger"
            onClick={() => onConfirm(survivorId, picked)}
          >
            {t("tools.duplicates.cluster.mergeAllConfirm", { count: removedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}
