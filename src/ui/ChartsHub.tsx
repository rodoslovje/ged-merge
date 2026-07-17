import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { TreeMode } from "../chart/personTree";
import type { CandidateDecision } from "../review/types";
import { useChartSettings, type ChartKind } from "./ChartSettingsContext";
import { ChartKindTabs, PEDIGREE_KINDS } from "./ChartKindTabs";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { ChartPage } from "./ChartPage";
import { EditTree } from "./EditTree";
import { RelationshipChart } from "./RelationshipChart";
import { TimelineChart } from "./TimelineChart";
import { ReportView } from "./ReportView";
import { StartPersonSelector } from "./StartPersonSelector";

// The Map is the one kind with a heavyweight dependency (Leaflet + the offline
// world outline), so it loads as its own chunk on first use.
const MapChart = lazy(() => import("./map/MapChart"));

// The full-page "Charts" hub for a person in the main file: one overlay that
// hosts every per-person diagram — the pedigree charts (tree / grid / fan /
// circle, drawn by EditTree), the relationship-to-start diagram, and the family
// timeline — behind a first-class kind switcher. The chosen kind persists
// (ChartSettingsContext), so the Edit view's single "Charts" button reopens
// whatever was used last.

/** The hub's kinds, in tab (and digit-shortcut) order — the per-person charts
 *  (pedigrees, then the timeline) first, then the two-person relationship,
 *  then the places map, then the text reports. */
const HUB_KINDS: ChartKind[] = [...PEDIGREE_KINDS, "timeline", "relationship", "map", "report"];

interface Props {
  mainDs: Dataset;
  /** The person the hub opened on; re-roots inside the hub follow the user. */
  initialRootId: string;
  startId?: string;
  changedPersonIds: Set<string>;
  decisions?: Map<string, CandidateDecision>;
  /** Translated label for where Back lands (App knows the hub's origin). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate: (id: string) => void;
  /** Set the app-wide start person (from the relationship kind's inline prompt). */
  onPickStart?: (id: string) => void;
}

export function ChartsHub({ mainDs, initialRootId, startId, changedPersonIds, decisions, backLabel, onBack, onNavigate, onPickStart }: Props) {
  const { t } = useTranslation();
  const { settings, setKind } = useChartSettings();
  // The hub's current person: starts at the person it was opened on and follows
  // re-roots (tree) / target swaps (relationship), so switching kinds stays on
  // the person the user is actually looking at.
  const [rootId, setRootId] = useState(initialRootId);
  // The user's ancestors/descendants choice — owned here (not by EditTree) so
  // it survives kind switches, including a relationship round-trip that
  // remounts the pedigree chart.
  const [treeMode, setTreeMode] = useState<TreeMode>("ancestors");

  // Digits 1–8 switch the kind (the chart-level keys — zoom, A/D, Esc — are
  // registered by whichever chart the hub is showing). Esc is handled here only
  // on the start-person prompt page, where no chart is mounted to own it.
  const showingPrompt = settings.kind === "relationship" && !startId;
  useChartShortcuts({ kinds: HUB_KINDS, onKind: setKind, onLeave: showingPrompt ? onBack : undefined });

  const kindSwitcher = (
    <ChartKindTabs
      kinds={HUB_KINDS}
      value={settings.kind}
      onChange={setKind}
    />
  );

  if (settings.kind === "report") {
    return (
      <ReportView
        mainDs={mainDs}
        rootId={rootId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={setRootId}
        kindSwitcher={kindSwitcher}
        mode={treeMode}
        onModeChange={setTreeMode}
      />
    );
  }

  if (settings.kind === "map") {
    return (
      <Suspense fallback={null}>
        <MapChart
          mainDs={mainDs}
          rootId={rootId}
          backLabel={backLabel}
          onBack={onBack}
          onNavigate={onNavigate}
          kindSwitcher={kindSwitcher}
          mode={treeMode}
          onModeChange={setTreeMode}
        />
      </Suspense>
    );
  }

  if (settings.kind === "timeline") {
    return (
      <TimelineChart
        mainDs={mainDs}
        rootId={rootId}
        startId={startId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={setRootId}
        kindSwitcher={kindSwitcher}
      />
    );
  }

  if (settings.kind === "relationship") {
    // The diagram needs a start person to measure from; prompt inline instead of
    // hiding the kind behind a disabled control.
    if (!startId) {
      return (
        <ChartPage
          backLabel={backLabel}
          onBack={onBack}
          title={<span className="tree-title-kind">{t("relpath.pageTitle")}</span>}
          controlsLeft={kindSwitcher}
        >
          <div className="charts-need-start">
            <p>{t("globalSearch.needStart")}</p>
            {onPickStart && (
              <StartPersonSelector
                individuals={mainDs.individuals}
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
        </ChartPage>
      );
    }
    return (
      <RelationshipChart
        mainDs={mainDs}
        startId={startId}
        targetId={rootId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onTargetChange={setRootId}
        kindSwitcher={kindSwitcher}
      />
    );
  }

  return (
    <EditTree
      mainDs={mainDs}
      rootId={rootId}
      startId={startId}
      changedPersonIds={changedPersonIds}
      decisions={decisions}
      backLabel={backLabel}
      onBack={onBack}
      onNavigate={onNavigate}
      mode={treeMode}
      onModeChange={setTreeMode}
      onRootChange={setRootId}
      kindSwitcher={kindSwitcher}
    />
  );
}
