import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { ChartDirection } from "../chart/treeLayout";
import type { CandidateDecision } from "../review/types";
import { useChartSettings, type ChartKind } from "./ChartSettingsContext";
import { ChartKindTabs, PEDIGREE_KINDS } from "./ChartKindTabs";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { ChartPage } from "./ChartPage";
import { EditTree } from "./EditTree";
import { RelationshipChart } from "./RelationshipChart";
import { TimelineChart } from "./TimelineChart";
import { TimelineLines } from "./TimelineLines";
import { KinshipChart } from "./KinshipChart";
import { ReportView } from "./ReportView";
import { NetworkChart } from "./NetworkChart";
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
 *  (pedigrees, then the timeline) first, then the two-person relationship, then
 *  the contemporaries wheel, then the places map, then the text reports. */
export const HUB_KINDS: ChartKind[] = [...PEDIGREE_KINDS, "timeline", "relationship", "kin", "map", "report", "network"];

interface Props {
  mainDs: Dataset;
  /** The person every kind is currently drawn for. Owned by App (and so by the
   *  browser history), not by the hub, so the Back button walks back through the
   *  people the user re-rooted on. */
  rootId: string;
  /** Re-root on another person — a new history entry, see App's openCharts. */
  onRootChange: (id: string) => void;
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
  /** The person the relationship diagram measures from when it is not the start
   *  person — a couple opened from Statistics, related to each other. */
  relationFromId?: string;
  /** The relationship diagram's "from" person was swapped in its title (the
   *  family website keeps it in its address). */
  onRelationFromChange?: (id: string) => void;
  /** Open Tools → Places → Geocode places (the Contemporaries map's unplaced list). */
  onOpenGeocode?: () => void;
  /** The ancestors/descendants/both choice, when the host keeps it — the family
   *  website does, in its address. Without these the hub keeps its own. */
  direction?: ChartDirection;
  onDirectionChange?: (direction: ChartDirection) => void;
}

export function ChartsHub({ mainDs, rootId, onRootChange, startId, relationFromId, onRelationFromChange, changedPersonIds, decisions, backLabel, onBack, onNavigate, onPickStart, onOpenGeocode, direction: hostDirection, onDirectionChange }: Props) {
  const { t } = useTranslation();
  const { settings, setKind } = useChartSettings();
  // The user's ancestors/descendants/both choice — owned here (not by
  // EditTree) so it survives kind switches, including a relationship
  // round-trip that remounts the pedigree chart. Every kind that has a
  // direction draws both at once: the pedigree charts as a bowtie, the map as
  // one point cloud, the report as its two lists one after the other.
  // Both to begin with: the bowtie shows the whole picture, and the counts on
  // the direction row say which side is worth opening on its own.
  const [ownDirection, setOwnDirection] = useState<ChartDirection>("both");
  const direction = hostDirection ?? ownDirection;
  const setDirection = onDirectionChange ?? setOwnDirection;
  // The layered chart's fourth choice beside the directions: the Complete Tree,
  // everyone connected. Kept here beside the direction, but not handed to the
  // other kinds — none of them has a "complete" of its own — and not offered
  // on the family website, whose address carries the direction alone.
  const [complete, setComplete] = useState(false);

  // Digits 1–8 switch the kind (the chart-level keys — zoom, A/D, Esc — are
  // registered by whichever chart the hub is showing). Esc is handled here only
  // on the start-person prompt page, where no chart is mounted to own it.
  const relationFrom = relationFromId ?? startId;
  const showingPrompt = settings.kind === "relationship" && !relationFrom;
  // H re-roots on the start person, whichever kind is up — the chart-side twin
  // of Edit's "go home". Registered here rather than per chart because the hub
  // owns the root; standing on them already, the key does nothing.
  useChartShortcuts({
    kinds: HUB_KINDS,
    onKind: setKind,
    onLeave: showingPrompt ? onBack : undefined,
    onHome: startId && startId !== rootId ? () => onRootChange(startId) : undefined,
  });

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
        startId={startId}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={onRootChange}
        kindSwitcher={kindSwitcher}
        mode={direction}
        onModeChange={setDirection}
      />
    );
  }

  if (settings.kind === "network") {
    return (
      <NetworkChart
        mainDs={mainDs}
        rootId={rootId}
        startId={startId}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={onRootChange}
        kindSwitcher={kindSwitcher}
      />
    );
  }

  if (settings.kind === "kin") {
    return (
      <KinshipChart
        mainDs={mainDs}
        rootId={rootId}
        startId={startId}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={onRootChange}
        kindSwitcher={kindSwitcher}
        onOpenGeocode={onOpenGeocode}
      />
    );
  }

  if (settings.kind === "map") {
    return (
      <Suspense fallback={null}>
        <MapChart
          mainDs={mainDs}
          rootId={rootId}
          startId={startId}
          backLabel={backLabel}
          onBack={onBack}
          onNavigate={onNavigate}
          onRootChange={onRootChange}
          kindSwitcher={kindSwitcher}
          mode={direction}
          onModeChange={setDirection}
        />
      </Suspense>
    );
  }

  if (settings.kind === "timeline") {
    const Timeline = settings.timelineLayout === "lines" ? TimelineLines : TimelineChart;
    return (
      <Timeline
        mainDs={mainDs}
        rootId={rootId}
        startId={startId}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onRootChange={onRootChange}
        kindSwitcher={kindSwitcher}
      />
    );
  }

  if (settings.kind === "relationship") {
    // The diagram needs a start person to measure from; prompt inline instead of
    // hiding the kind behind a disabled control.
    if (!relationFrom) {
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
        startId={relationFrom}
        targetId={rootId}
        backLabel={backLabel}
        onBack={onBack}
        onNavigate={onNavigate}
        onTargetChange={onRootChange}
        onStartChange={onRelationFromChange}
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
      direction={direction}
      onDirectionChange={setDirection}
      complete={complete && !hostDirection}
      onCompleteChange={hostDirection ? undefined : setComplete}
      onRootChange={onRootChange}
      kindSwitcher={kindSwitcher}
    />
  );
}
