import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { CandidateDecision } from "../review/types";
import { useChartSettings } from "./ChartSettingsContext";
import { ChartKindTabs, PEDIGREE_KINDS } from "./ChartKindTabs";
import { EditTree } from "./EditTree";
import { RelationshipChart } from "./RelationshipChart";
import { StartPersonSelector } from "./StartPersonSelector";

// The full-page "Charts" hub for a person in the master file: one overlay that
// hosts every per-person diagram — the pedigree charts (tree / grid / fan /
// circle, drawn by EditTree) and the relationship-to-start diagram — behind a
// first-class kind switcher. The chosen kind persists (ChartSettingsContext),
// so the Edit view's single "Charts" button reopens whatever was used last.

interface Props {
  masterDs: Dataset;
  /** The person the hub opened on; re-roots inside the hub follow the user. */
  initialRootId: string;
  startId?: string;
  changedPersonIds: Set<string>;
  decisions?: Map<string, CandidateDecision>;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate: (id: string) => void;
  /** Set the app-wide start person (from the relationship kind's inline prompt). */
  onPickStart?: (id: string) => void;
}

export function ChartsHub({ masterDs, initialRootId, startId, changedPersonIds, decisions, onBack, onNavigate, onPickStart }: Props) {
  const { t } = useTranslation();
  const { settings, setKind } = useChartSettings();
  // The hub's current person: starts at the person it was opened on and follows
  // re-roots (tree) / target swaps (relationship), so switching kinds stays on
  // the person the user is actually looking at.
  const [rootId, setRootId] = useState(initialRootId);

  const kindSwitcher = (
    <ChartKindTabs
      kinds={[...PEDIGREE_KINDS, "relationship"]}
      value={settings.kind}
      onChange={setKind}
    />
  );

  if (settings.kind === "relationship") {
    // The diagram needs a start person to measure from; prompt inline instead of
    // hiding the kind behind a disabled control.
    if (!startId) {
      return (
        <div className="tree-page">
          <div className="tree-toolbar">
            <button className="tree-open-btn tree-back-btn" onClick={onBack} title={t("edit.tree.back")} aria-label={t("edit.tree.back")}>
              ← <span className="tree-back-label">{t("edit.tree.back")}</span>
            </button>
            <h2 className="tree-title">
              <span className="tree-title-kind">{t("relpath.pageTitle")}</span>
            </h2>
          </div>
          <div className="tree-controls">
            <div className="tree-controls-left">{kindSwitcher}</div>
          </div>
          <div className="charts-need-start">
            <p>{t("globalSearch.needStart")}</p>
            {onPickStart && (
              <StartPersonSelector
                individuals={masterDs.individuals}
                startId={undefined}
                onChange={onPickStart}
                icon="search"
                autoFocus
                selectedAsPlaceholder={false}
                placeholder={t("relpath.searchPerson")}
                tooltip={t("relpath.searchPerson")}
              />
            )}
          </div>
        </div>
      );
    }
    return (
      <RelationshipChart
        masterDs={masterDs}
        startId={startId}
        targetId={rootId}
        onBack={onBack}
        onNavigate={onNavigate}
        onTargetChange={setRootId}
        kindSwitcher={kindSwitcher}
      />
    );
  }

  return (
    <EditTree
      masterDs={masterDs}
      rootId={rootId}
      startId={startId}
      changedPersonIds={changedPersonIds}
      decisions={decisions}
      onBack={onBack}
      onRootChange={setRootId}
      kindSwitcher={kindSwitcher}
    />
  );
}
