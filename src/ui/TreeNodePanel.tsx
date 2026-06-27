import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FieldRow } from "../review/types";
import type { Placed } from "../tree/treeLayout";
import { ReadOnlyCompare, type PersonNav } from "./ReadOnlyCompare";
import { sexClass } from "./sex";

interface Props {
  node: Placed;
  /** Swatch colour beside the name (status colour, or modified/normal colour). */
  swatch: string;
  rows: FieldRow[];
  masterPerson: PersonNav;
  /** Incoming-side navigation; omitted in single-column (Edit Tree) mode. */
  incomingPerson?: PersonNav;
  masterLabel: string;
  incomingLabel?: string;
  /** Show only labels + master column (no incoming side). */
  singleColumn?: boolean;
  onClose: () => void;
  /** Re-root the tree on this person ("Set as root"). */
  onSetRoot: () => void;
  /** Label for the primary action button; defaults to the "Set as root" wording. */
  rootLabel?: string;
  /** When set, the title becomes a button (Compare Tree: open in Matches). */
  onTitleClick?: () => void;
  titleHint?: string;
  /** Kinship label to the home person, shown after the lifespan in the title. */
  kinship?: string;
  /** Chips shown on the actions row, left of the Set-as-root button. */
  badges?: ReactNode;
  /** Extra control rows shown between the actions row and the field table
   *  (Compare Tree: the decision bar and import button). */
  controls?: ReactNode;
}

/**
 * Floating detail panel for a selected tree node, shared by the Edit Tree and
 * Compare Tree. Renders the person header, a "Set as root" action, any
 * view-specific controls, and the read-only field table — as a Master↔Incoming
 * comparison (Compare Tree) or a single master column (Edit Tree).
 */
export function TreeNodePanel({
  node,
  swatch,
  rows,
  masterPerson,
  incomingPerson,
  masterLabel,
  incomingLabel,
  singleColumn,
  onClose,
  onSetRoot,
  rootLabel,
  onTitleClick,
  titleHint,
  kinship,
  badges,
  controls,
}: Props) {
  const { t } = useTranslation();
  const title = (
    <>
      <span className="tree-compare-title-main">
        <span className={`tree-compare-name ${sexClass(node.sex)}`}>{node.name}</span>
        {node.years && <span className="tree-compare-years gm-data">{node.years}</span>}
      </span>
      {kinship && <span className="tree-compare-kinship gm-data">{kinship}</span>}
    </>
  );
  return (
    <div className="tree-compare">
      <div className="tree-compare-head">
        <span className="tree-swatch" style={{ background: swatch }} />
        {onTitleClick ? (
          <button className="tree-compare-title tree-compare-title-link" onClick={onTitleClick} title={titleHint}>
            {title}
          </button>
        ) : (
          <span className="tree-compare-title">{title}</span>
        )}
        <button className="tree-compare-close" onClick={onClose} title={t("tree.close")}>
          ×
        </button>
      </div>
      <div className="tree-compare-actions">
        {badges}
        <button className="nav-btn tree-compare-root" onClick={onSetRoot}>
          {rootLabel ?? t("edit.tree.reroot")}
        </button>
      </div>
      {controls}
      <div className="tree-compare-body">
        <ReadOnlyCompare
          rows={rows}
          masterPerson={masterPerson}
          incomingPerson={incomingPerson ?? masterPerson}
          masterLabel={masterLabel}
          incomingLabel={incomingLabel ?? ""}
          singleColumn={singleColumn}
        />
      </div>
    </div>
  );
}
