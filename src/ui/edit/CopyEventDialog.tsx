import { useEffect, useMemo, useState } from "react";
import type { Dataset, GedNode, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { childValue } from "../../gedcom/node";
import { lifespanOf } from "../../gedcom/lifespan";
import { individualCopyBlock, familyCopyBlock, type CopyEventBlock } from "../../gedcom/edit";
import { useNameOf } from "../SettingsContext";
import { foldSearch, matchesTerms, queryTerms } from "../globalSearch";

/** An event the user asked to copy, and where it came from. */
export interface CopyEventRequest {
  /** Which record kind the event lives on — and therefore the only kind it can
   * be copied to (an individual event belongs on an individual, a family
   * event on a family). */
  kind: "individual" | "family";
  /** The event subtree to clone. Lives on the source record. */
  node: GedNode;
  /** The source record's xref, excluded from the target list. */
  sourceId: string;
  /** Localized event name ("Residence"), for the dialog's heading. */
  label: string;
}

/** One candidate target record. */
interface Row {
  id: string;
  name: string;
  /** Lifespan / family detail shown after the name. */
  detail: string;
  /** Set when this record can't take the copy — the reason is shown inline. */
  blocked?: CopyEventBlock;
  search: string;
}

/** The two sections of the individual list; families are one flat list. */
type GroupKey = "relatives" | "others";

/** The source person's household: partners, children, parents and siblings —
 * the targets a "copy this residence to the rest of the family" pass is really
 * after, so they lead the list instead of being buried alphabetically. */
function relativeIdsOf(dataset: Dataset, personId: string): Set<string> {
  const ids = new Set<string>();
  const person = dataset.individuals.get(personId);
  if (!person) return ids;
  for (const famId of person.spouseOf) {
    const fam = dataset.families.get(famId);
    if (!fam) continue;
    for (const id of [fam.husband, fam.wife, ...fam.children]) if (id) ids.add(id);
  }
  for (const famId of person.childOf) {
    const fam = dataset.families.get(famId);
    if (!fam) continue;
    for (const id of [fam.husband, fam.wife, ...fam.children]) if (id) ids.add(id);
  }
  ids.delete(personId);
  return ids;
}

/** "12 Mar 1920 · Kranj 14" — what the event carries, so the user can confirm
 * they're handing on the right one before picking targets. */
function eventSummary(node: GedNode): string {
  const parts = [
    node.value?.trim(),
    childValue(node, "DATE"),
    childValue(node, "PLAC"),
    childValue(node, "ADDR"),
  ].filter((p): p is string => !!p && !!p.trim());
  return parts.join(" · ");
}

/**
 * Pick the records an event is copied to. Individual events only ever offer
 * individuals and family events only families (a `RESI` belongs on a person, a
 * `MARR` on a couple), so the list never shows something the copy couldn't
 * land on. Records that already carry the event are listed but not selectable,
 * with the reason spelled out.
 */
export function CopyEventDialog({
  request,
  dataset,
  t,
  onCancel,
  onConfirm,
}: {
  request: CopyEventRequest;
  dataset: Dataset;
  t: Translate;
  onCancel: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const nameOf = useNameOf();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const { kind, node, sourceId } = request;

  const groups = useMemo(() => {
    const label = (indi: Individual) => nameOf(indi);
    if (kind === "individual") {
      const relatives = relativeIdsOf(dataset, sourceId);
      const rows: Record<GroupKey, Row[]> = { relatives: [], others: [] };
      for (const indi of dataset.individuals.values()) {
        if (indi.id === sourceId) continue;
        const name = label(indi);
        const detail = lifespanOf(indi);
        rows[relatives.has(indi.id) ? "relatives" : "others"].push({
          id: indi.id,
          name,
          detail,
          blocked: individualCopyBlock(indi, node),
          search: foldSearch(`${name} ${detail} ${indi.id}`),
        });
      }
      for (const key of ["relatives", "others"] as GroupKey[]) {
        rows[key].sort((a, b) => a.name.localeCompare(b.name));
      }
      return [
        { key: "relatives" as GroupKey, title: t("copyEvent.relatives"), rows: rows.relatives },
        { key: "others" as GroupKey, title: t("copyEvent.others"), rows: rows.others },
      ].filter((g) => g.rows.length > 0);
    }
    const rows: Row[] = [];
    for (const fam of dataset.families.values()) {
      if (fam.id === sourceId) continue;
      const spouses = [fam.husband, fam.wife]
        .map((id) => (id ? dataset.individuals.get(id) : undefined))
        .filter((i): i is Individual => !!i)
        .map(label);
      const name = spouses.join(" + ") || fam.id;
      const detail = t("copyEvent.childCount", { count: fam.children.length });
      rows.push({
        id: fam.id,
        name,
        detail,
        blocked: familyCopyBlock(fam, node),
        search: foldSearch(`${name} ${fam.id}`),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return [{ key: "others" as GroupKey, title: t("copyEvent.families"), rows }];
  }, [kind, dataset, sourceId, node, nameOf, t]);

  const terms = queryTerms(query);
  const shown = groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => matchesTerms(r.search, terms)) }))
    .filter((g) => g.rows.length > 0);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Tick (or clear) every selectable row currently shown in a group — how a
   * whole household is handed the event in one click. */
  function toggleGroup(rows: Row[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (r.blocked) continue;
        if (on) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  }

  const summary = eventSummary(node);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal copy-event-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("copyEvent.title", { event: request.label })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t("copyEvent.title", { event: request.label })}</h2>
          <div className="name-search-wrap copy-event-search">
            <input
              type="text"
              className="name-search"
              placeholder={kind === "individual" ? t("copyEvent.searchPeople") : t("copyEvent.searchFamilies")}
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="name-search-clear"
                onClick={() => setQuery("")}
                tabIndex={-1}
                aria-label={t("filter.clearSearch")}
              >
                ✕
              </button>
            )}
          </div>
          <button className="modal-close" onClick={onCancel} title={t("help.close")}>×</button>
        </div>
        <div className="modal-body copy-event-body">
          {summary && <div className="copy-event-summary gm-data">{summary}</div>}
          {shown.length === 0 && <div className="copy-event-empty">{t("start.noMatches")}</div>}
          {shown.map((g) => {
            const selectable = g.rows.filter((r) => !r.blocked);
            const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
            return (
              <div key={g.key}>
                <div className="copy-event-section">
                  <span>{g.title}</span>
                  {selectable.length > 1 && (
                    <label className="copy-event-all">
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={(e) => toggleGroup(g.rows, e.target.checked)}
                      />
                      {t("copyEvent.selectAll")}
                    </label>
                  )}
                </div>
                <ul className="copy-event-list">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <label className={"copy-event-row" + (r.blocked ? " copy-event-row--blocked" : "")}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          disabled={!!r.blocked}
                          onChange={() => toggle(r.id)}
                        />
                        <span className="copy-event-name">{r.name}</span>
                        {r.detail && <span className="copy-event-detail gm-data">{r.detail}</span>}
                        {r.blocked && (
                          <span className="copy-event-blocked">{t(`copyEvent.blocked.${r.blocked}`)}</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="copy-event-footer">
          <button className="tree-open-btn" onClick={onCancel}>{t("copyEvent.cancel")}</button>
          <button
            className="tree-open-btn"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected])}
          >
            {t("copyEvent.confirm", { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
