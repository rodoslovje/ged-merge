import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import type { Sex } from "../gedcom/types";
import type { MatchDecisionStatus } from "../review/types";
import { AddPersonIcon } from "./icons/AddPersonIcon";
import { SearchIcon } from "./icons/SearchIcon";
import { sexClass } from "./sex";
import {
  searchPeople,
  hasActiveFilters,
  NO_FILTERS,
  type SearchRow,
  type GlobalFilters,
  type FilterContext,
} from "./globalSearch";

/** How a chosen result should open — routed by the host (Merge vs Edit). */
export type OpenHow = "open" | "tree" | "relationship";

/** Optional per-row extras shown next to the name, honouring app settings:
 *  the record id (when "show record ids" is on) and the kinship-to-start label
 *  (when kinship display is on and a start person is set). */
export interface SearchRowMeta {
  xref?: string;
  kinship?: string;
  /** Lineage CSS modifier (e.g. "lineage-paternal") for colouring the label. */
  kinshipLineage?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Precomputed search index for the whole main (see {@link buildSearchRows}). */
  rows: SearchRow[];
  /** Open a chosen person in the requested way (open in Merge/Edit, tree, or relationship). */
  onOpen: (id: string, how: OpenHow) => void;
  /** Cross-cutting edit/decision lookups for the attribute facets. */
  filterContext: FilterContext;
  /** Per-row record-id / kinship extras (see {@link SearchRowMeta}). */
  metaOf: (id: string) => SearchRowMeta;
  /** The current start person — the relationship diagram is measured from them,
   *  so its action is disabled when unset or when the row *is* the start person. */
  startId?: string;
  /** Whether any merge decisions exist — gates the decision facet. */
  hasDecisions: boolean;
  /** Create a new, unattached person named after the current query — offered
   *  when the search comes up empty, which is exactly when the person the user
   *  is looking for turns out not to be in the file yet. */
  onCreatePerson: (name: string) => void;
}

/** Relationship-hop presets for the kinship facet (hops from the start person).
 *  Parent/child = 1, sibling/grandparent = 2, aunt-uncle = 3, 1st cousin = 4. */
const KINSHIP_PRESETS = [1, 2, 4, 6, 8];

// Only the three explicit decisions are per-person filterable; "undecided" is
// the absence of a decision, so it isn't offered as a facet value.
const DECISION_STATUSES: MatchDecisionStatus[] = ["confirmed", "deferred", "rejected"];

/** Parse a year input into a number, or undefined when blank/invalid. */
function toYear(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Whole-dataset person search, opened with `/` from any mode. Filters the
 * precomputed index by name/lifespan plus attribute facets (sex, birth year,
 * place, attachments, edit/decision status) and hands the chosen person back to
 * the host, which decides whether to land it in Merge (a match candidate) or
 * Edit. Enter opens; Shift+Enter opens the tree.
 */
export function GlobalSearchModal({ isOpen, onClose, rows, onOpen, filterContext, metaOf, startId, hasDecisions, onCreatePerson }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(isOpen, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [filters, setFilters] = useState<GlobalFilters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  // Reset query and facets each time the dialog opens so it never reopens stale.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIndex(0);
      setFilters(NO_FILTERS);
      setShowFilters(false);
    }
  }, [isOpen]);

  const results = useMemo(
    () => searchPeople(rows, query, filters, filterContext),
    [rows, query, filters, filterContext],
  );
  const filtersActive = hasActiveFilters(filters);

  // Keep the highlight in range and scrolled into view as the list changes.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!isOpen) return null;

  function choose(row: SearchRow | undefined, how: OpenHow) {
    if (!row) return;
    onOpen(row.id, how);
    onClose();
  }

  // Nothing found and something typed to name them by: the search doubles as
  // the way to add the person who turned out to be missing.
  const createName = query.trim();
  const canCreate = results.length === 0 && createName.length > 0;

  function create() {
    if (!canCreate) return;
    onCreatePerson(createName);
    onClose();
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // With no results, Enter takes the only action left: create the person.
      if (canCreate) create();
      else choose(results[activeIndex], e.shiftKey ? "tree" : "open");
    }
  }

  const setSex = (sex: Sex | undefined) => setFilters((f) => ({ ...f, sex: f.sex === sex ? undefined : sex }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal global-search-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("globalSearch.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="global-search-field">
          <span className="global-search-icon" aria-hidden="true">
            <SearchIcon size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="global-search-input"
            placeholder={t("globalSearch.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            autoFocus
          />
          <button
            type="button"
            className={`global-search-filter-toggle${showFilters || filtersActive ? " active" : ""}`}
            onClick={() => setShowFilters((v) => !v)}
            title={t("globalSearch.filters")}
            aria-pressed={showFilters}
          >
            {t("globalSearch.filters")}
            {filtersActive && <span className="global-search-filter-dot" aria-hidden="true" />}
          </button>
        </div>

        {showFilters && (
          <div className="global-search-facets">
            <div className="gsf-group">
              <span className="gsf-label">{t("globalSearch.facet.sex")}</span>
              <button type="button" className={`gsf-chip${filters.sex === undefined ? " active" : ""}`} onClick={() => setSex(undefined)}>
                {t("globalSearch.facet.any")}
              </button>
              <button type="button" className={`gsf-chip sex-m${filters.sex === "M" ? " active" : ""}`} onClick={() => setSex("M")}>
                {t("sex.M")}
              </button>
              <button type="button" className={`gsf-chip sex-f${filters.sex === "F" ? " active" : ""}`} onClick={() => setSex("F")}>
                {t("sex.F")}
              </button>
            </div>

            <div className="gsf-group">
              <span className="gsf-label">{t("globalSearch.facet.born")}</span>
              <input
                type="number"
                className="gsf-year"
                placeholder={t("globalSearch.facet.from")}
                value={filters.bornFrom ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, bornFrom: toYear(e.target.value) }))}
              />
              <span className="gsf-dash">–</span>
              <input
                type="number"
                className="gsf-year"
                placeholder={t("globalSearch.facet.to")}
                value={filters.bornTo ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, bornTo: toYear(e.target.value) }))}
              />
            </div>

            <div className="gsf-group gsf-grow">
              <span className="gsf-label">{t("globalSearch.facet.place")}</span>
              <input
                type="text"
                className="gsf-place"
                placeholder={t("globalSearch.facet.placePlaceholder")}
                value={filters.place}
                onChange={(e) => setFilters((f) => ({ ...f, place: e.target.value }))}
              />
            </div>

            <div className="gsf-group">
              <span className="gsf-label">{t("globalSearch.facet.has")}</span>
              <button type="button" className={`gsf-chip${filters.hasLinks ? " active" : ""}`} onClick={() => setFilters((f) => ({ ...f, hasLinks: !f.hasLinks }))}>
                {t("globalSearch.facet.links")}
              </button>
              <button type="button" className={`gsf-chip${filters.hasNotes ? " active" : ""}`} onClick={() => setFilters((f) => ({ ...f, hasNotes: !f.hasNotes }))}>
                {t("globalSearch.facet.notes")}
              </button>
              <button type="button" className={`gsf-chip${filters.hasSources ? " active" : ""}`} onClick={() => setFilters((f) => ({ ...f, hasSources: !f.hasSources }))}>
                {t("globalSearch.facet.sources")}
              </button>
              <button type="button" className={`gsf-chip${filters.edited ? " active" : ""}`} onClick={() => setFilters((f) => ({ ...f, edited: !f.edited }))}>
                {t("globalSearch.facet.edited")}
              </button>
            </div>

            {startId && (
              <div className="gsf-group">
                <span className="gsf-label">{t("globalSearch.facet.kinship")}</span>
                <select
                  className="gsf-select"
                  value={filters.maxKinship ?? ""}
                  onChange={(e) => setFilters((f) => ({ ...f, maxKinship: e.target.value ? Number(e.target.value) : undefined }))}
                >
                  <option value="">{t("globalSearch.facet.any")}</option>
                  {KINSHIP_PRESETS.map((hops) => (
                    <option key={hops} value={hops}>{t("globalSearch.facet.withinHops", { count: hops })}</option>
                  ))}
                </select>
              </div>
            )}

            {hasDecisions && (
              <div className="gsf-group">
                <span className="gsf-label">{t("globalSearch.facet.decision")}</span>
                <select
                  className="gsf-select"
                  value={filters.decision ?? ""}
                  onChange={(e) => setFilters((f) => ({ ...f, decision: (e.target.value || undefined) as MatchDecisionStatus | undefined }))}
                >
                  <option value="">{t("globalSearch.facet.any")}</option>
                  {DECISION_STATUSES.map((s) => (
                    <option key={s} value={s}>{t(`status.${s}`)}</option>
                  ))}
                </select>
              </div>
            )}

            {filtersActive && (
              <button type="button" className="gsf-clear" onClick={() => setFilters(NO_FILTERS)}>
                {t("globalSearch.facet.clear")}
              </button>
            )}
          </div>
        )}

        <ul className="global-search-results" ref={listRef}>
          {results.map((row, i) => {
            // Relating a person to themselves is meaningless; without a start
            // person the hub shows its inline "set a start person" prompt.
            const canRelate = startId !== row.id;
            const meta = metaOf(row.id);
            return (
              <li
                key={row.id}
                className={`global-search-row${i === activeIndex ? " highlighted" : ""}`}
                data-index={i}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <button type="button" className="global-search-open" onClick={() => choose(row, "open")}>
                  <span className={`global-search-name ${sexClass(row.sex)}`}>{row.name}</span>
                  {meta.xref && <span className="global-search-xref">{meta.xref}</span>}
                  {row.span && <span className="global-search-span">{row.span}</span>}
                  {meta.kinship && (
                    <span className={`global-search-kin ${meta.kinshipLineage ?? ""}`}>{meta.kinship}</span>
                  )}
                </button>
                <div className="global-search-actions">
                  <button
                    type="button"
                    className="global-search-action"
                    title={t("edit.charts.tooltip")}
                    onClick={() => choose(row, "tree")}
                  >
                    {t("edit.charts.button")}
                  </button>
                  <button
                    type="button"
                    className="global-search-action"
                    title={canRelate ? t("relpath.tooltip") : t("globalSearch.needStart")}
                    disabled={!canRelate}
                    onClick={() => choose(row, "relationship")}
                  >
                    {t("relpath.button")}
                  </button>
                </div>
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="global-search-empty">
              <span className="muted">{t("globalSearch.empty")}</span>
              {canCreate && (
                <button type="button" className="global-search-create" onClick={create}>
                  <AddPersonIcon size={14} />
                  {t("globalSearch.create", { name: createName })}
                </button>
              )}
            </li>
          )}
        </ul>
        <div className="global-search-footer">
          <span>{t("globalSearch.count", { count: results.length })}</span>
          <span className="global-search-hints">{canCreate ? t("globalSearch.hints.create") : t("globalSearch.hints")}</span>
        </div>
      </div>
    </div>
  );
}
