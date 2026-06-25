import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { datesTooltip, formatLifespan } from "../gedcom/lifespan";
import type { MatchResult } from "../match/types";
import { decisionKey, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { kinshipLabel } from "../match/kinship";
import { displayName, primaryName } from "../match/relatives";
import { MatchResults } from "./MatchResults";
import { ComparePanel } from "./ComparePanel";
import { Section } from "./Section";
import { sexClass } from "./sex";
import {
  type Candidate,
  type Filters,
  type SortKey,
  type SortState,
} from "./matchView";

interface Props {

  // Matches section
  matches: MatchResult | null;
  sort: SortState[];
  onToggleSort: (key: SortKey) => void;
  filters: Filters;
  setFilters: (filters: Filters) => void;
  visible: Candidate[];
  /** Index of current in visible; -1 when current is filtered out. */
  visibleIndex: number;
  /** Position of current in the full sorted list (for prev/next nav). */
  allSortedIndex: number;
  allSortedCount: number;
  onSelectPrev: () => void;
  onSelectNext: () => void;
  onSelect: (index: number) => void;
  decisions: Map<string, CandidateDecision>;
  showFilters: boolean;
  setShowFilters: Dispatch<SetStateAction<boolean>>;
  homeId: string | undefined;
  masterDataset: Dataset | undefined;
  openMatches: boolean;
  setOpenMatches: Dispatch<SetStateAction<boolean>>;

  // Compare panel
  current: Candidate | undefined;
  compareDataset: Dataset | undefined;
  onUpdateDecision: (next: CandidateDecision) => void;
  onOpenTree: (masterId: string, compareId: string) => void;
  canNavigatePerson: (side: "master" | "incoming", id: string) => boolean;
  onNavigatePerson: (side: "master" | "incoming", id: string) => void;
  compareRef: RefObject<HTMLDivElement | null>;
  /** False when Merge is mounted but hidden behind Edit mode — kept mounted
   * across mode switches so toggling modes with a large match list doesn't
   * re-render the whole tab from scratch. Gates the global keydown shortcut
   * so it doesn't fire while another mode is the one actually visible. */
  active: boolean;
}

/** The merge workflow: incoming loader, matches list, compare panel, and the
 * merge preview/export modal. Extracted from App.tsx as the "Merge" mode body
 * — the Master GEDCOM is loaded by the shared shell. */
export function MergeView({
  matches,
  sort,
  onToggleSort,
  filters,
  setFilters,
  visible,
  visibleIndex,
  allSortedIndex,
  allSortedCount,
  onSelectPrev,
  onSelectNext,
  onSelect,
  decisions,
  showFilters,
  setShowFilters,
  homeId,
  masterDataset,
  openMatches,
  setOpenMatches,
  current,
  compareDataset,
  onUpdateDecision,
  onOpenTree,
  canNavigatePerson,
  onNavigatePerson,
  compareRef,
  active,
}: Props) {
  const { t } = useTranslation();

  const compareBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    compareBodyRef.current?.scrollTo({ top: 0 });
  }, [current]);

  const matchesSubtitle = matches ? (
    <div className="matches-actions" onClick={(e) => e.stopPropagation()}>
      <span className="muted gm-data">
        {t("list.count", { visible: visible.length, total: matches.individuals.length })}
      </span>
      <button
        className={`nav-btn icon-only ${showFilters ? "active" : ""}`}
        onClick={() => setShowFilters((s) => !s)}
        title={t("filter.title")}
      >
        <svg style={{ display: "block" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
      </button>
    </div>
  ) : undefined;

  const kinship = current && homeId && masterDataset
    ? kinshipLabel(masterDataset, homeId, current.masterId, t)
    : undefined;
  const homePersonName = homeId && masterDataset
    ? displayName(primaryName(masterDataset.individuals.get(homeId)!))
    : undefined;
  const kinshipTooltip = kinship && homePersonName
    ? t("kinship.tooltip", { kinship, name: homePersonName })
    : undefined;

  const STATUSES: MatchDecisionStatus[] = ["confirmed", "rejected", "deferred"];
  const currentDecision = current
    ? decisions.get(decisionKey("individual", current.masterId, current.compareId))
    : undefined;
  const status = currentDecision?.status ?? "undecided";
  const fields = currentDecision?.fields ?? {};
  const shortcutOf = (s: MatchDecisionStatus) => t(`status.${s}`).charAt(0).toLowerCase();

  function toggleStatus(next: MatchDecisionStatus) {
    if (!current) return;
    onUpdateDecision({ status: status === next ? "undecided" : next, fields });
  }

  useEffect(() => {
    if (!active || !current) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Left/Right move to the previous/next candidate; Up/Down scroll the
      // compare panel instead (when it actually has something to scroll) —
      // freed up rather than also navigating, so a long compare table can be
      // read with the keyboard without losing your place in the match list.
      if (e.key === "ArrowLeft") { e.preventDefault(); onSelectPrev(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); onSelectNext(); return; }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const el = compareBodyRef.current;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        e.preventDefault();
        el.scrollBy({ top: e.key === "ArrowDown" ? 96 : -96, behavior: "smooth" });
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "t") { e.preventDefault(); onOpenTree(current!.masterId, current!.compareId); return; }
      const hit = STATUSES.find((s) => shortcutOf(s) === key);
      if (hit) toggleStatus(hit);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, current, onUpdateDecision, status, fields, t, onSelectPrev, onSelectNext]); // STATUSES/onOpenTree/shortcutOf/toggleStatus intentionally omitted — module constants or stable-ref callbacks

  const compareHeader = current ? (
    <>
      <div className={`person-label ${sexClass(current.sex)}`}>
        <span className="person-name-group">
          <span className="person-name">{current.name}</span>
          {formatLifespan(current.birthYear, current.deathYear, current.deceased) && (
            <span
              className="person-years gm-data"
              title={datesTooltip(current.birthDate, current.deathDate, current.deceased)}
            >
              {formatLifespan(current.birthYear, current.deathYear, current.deceased)}
            </span>
          )}
          {status !== "undecided" && (
            <span className={`status-chip ${status}`} title={t(`status.${status}`)}>
              {t(`status.${status}`).charAt(0)}
            </span>
          )}
        </span>
        {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
      </div>
      <div className="compare-nav-header">
        <button
          className="nav-btn icon-only"
          onClick={onSelectPrev}
          disabled={allSortedIndex <= 0}
          title={t("nav.prev")}
        >
          ‹
        </button>
        <span className="nav-pos gm-data">
          {t("nav.pos", { current: allSortedIndex + 1, total: allSortedCount })}
        </span>
        <button
          className="nav-btn icon-only"
          onClick={onSelectNext}
          disabled={allSortedIndex >= allSortedCount - 1}
          title={t("nav.next")}
        >
          ›
        </button>
      </div>
      <div className="compare-head-actions">
        <div className="decision-bar compare-name-decisions">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={status === s ? `decision ${s} active` : "decision"}
              title={t("compare.shortcut", { key: shortcutOf(s).toUpperCase() })}
              onClick={() => toggleStatus(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>
        <div className="compare-nav-actions">
          <button className="tree-open-btn" onClick={() => onOpenTree(current.masterId, current.compareId)} title={t("tree.tooltip")}>
            {t("tree.button")}
          </button>
        </div>
      </div>
    </>
  ) : null;

  return (
    <>
      {/* Matches + Compare: shown once matching is done */}
      {matches && (
        <>
          <div className="main-split">
            <div className="split-pane split-matches">
              <Section
                title={t("section.matches")}
                subtitle={matchesSubtitle}
                open={openMatches}
                onToggle={() => setOpenMatches((o) => !o)}
              >
                <MatchResults
                  result={matches}
                  sort={sort}
                  onToggleSort={onToggleSort}
                  filters={filters}
                  onFilters={setFilters}
                  list={visible}
                  selectedIndex={visibleIndex}
                  onSelect={onSelect}
                  decisions={decisions}
                  showFilters={showFilters}
                  showRelation={!!homeId}
                />
              </Section>
            </div>

            <div className="split-pane split-compare" ref={compareRef}>
              <div className="section open">
                {compareHeader && <div className="section-head compare-head">{compareHeader}</div>}
                <div className="section-body" ref={compareBodyRef}>
                  {current && masterDataset && compareDataset ? (
                    <ComparePanel
                      candidate={current}
                      masterDs={masterDataset}
                      compareDs={compareDataset}
                      decision={decisions.get(decisionKey("individual", current.masterId, current.compareId))}
                      onChange={onUpdateDecision}
                      canNavigate={canNavigatePerson}
                      onNavigate={onNavigatePerson}
                    />
                  ) : (
                    <p className="muted">{t("compare.empty")}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

    </>
  );
}
