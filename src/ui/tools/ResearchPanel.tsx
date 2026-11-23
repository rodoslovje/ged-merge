import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { researchIndex, type ResearchFields } from "../../gedcom/edit";
import { displayDateText } from "../../gedcom/dateDisplay";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import type { ResearchNote, ResearchRef } from "../../gedcom/research";
import type { Dataset } from "../../gedcom/types";
import { ResearchDialog } from "../edit/ResearchDialog";
import { RESEARCH_ICON, researchTitle } from "../edit/ResearchContext";
import { applyResearchEdit, NEW_RESEARCH_FIELDS, researchDraftOf, type NewResearchMedia, type ResearchDraft, type ResearchTarget } from "../edit/researchEdit";
import { foldSearch, matchesTerms } from "../globalSearch";
import type { RecordPatch } from "../historyTypes";
import { PersonLink } from "../PersonLink";
import { Segmented } from "../Segmented";
import { useNameOf } from "../SettingsContext";
import { useQueryTerms } from "../useQueryTerms";
import { ToolsIntro, TreeSearch } from "./shared";

type Status = "open" | "done" | "all";
const STATUSES: Status[] = ["open", "done", "all"];

/**
 * The research notebook: every research note of the file in one list — the
 * ones not filed under anyone first — with the people and events each is
 * filed under. Notes are added, edited and settled here as in Edit.
 */
export function ResearchPanel({
  dataset,
  editVersion,
  onNavigate,
  onApply,
}: {
  dataset: Dataset;
  /** Bumped on every committed edit: the list is read again off it. */
  editVersion: number;
  onNavigate: (id: string) => void;
  /** Push one note edit's patches as an undo step and mark its records dirty. */
  onApply: (patches: RecordPatch[]) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const [status, setStatus] = useState<Status>("open");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ResearchDraft | null>(null);
  const terms = useQueryTerms(query);

  // The index itself is kept until the file changes (see `researchIndex`);
  // `editVersion` only says when to ask for it again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const index = useMemo(() => researchIndex(dataset.records), [dataset, editVersion]);

  const apply = (noteId: string | undefined, fields: ResearchFields | null, targets: ResearchTarget[], newMedia?: NewResearchMedia) =>
    onApply(applyResearchEdit(dataset, noteId, fields, targets, newMedia));

  function toggleDone(note: ResearchNote) {
    const existing = researchDraftOf(dataset, note.id);
    if (existing) apply(note.id, { ...existing.fields, done: !existing.fields.done }, existing.targets);
  }

  function whereLabel(ref: ResearchRef): string {
    const fam = dataset.families.get(ref.recordId);
    const partners = [fam?.husband, fam?.wife].map((id) => (id ? dataset.individuals.get(id) : undefined));
    return partners.filter((p) => !!p).map((p) => nameOf(p)).join(" + ") || ref.recordId;
  }

  const shown = index.notes.filter((note) => {
    if (status !== "all" && note.done !== (status === "done")) return false;
    if (!terms.length) return true;
    const people = (index.refs.get(note.id) ?? []).map((ref) => {
      const indi = dataset.individuals.get(ref.recordId);
      return indi ? nameOf(indi) : whereLabel(ref);
    });
    return matchesTerms(foldSearch([note.text, ...note.links, ...people].join(" ")), terms);
  });
  const unfiled = shown.filter((note) => !index.refs.get(note.id)?.length);
  const filed = shown.filter((note) => index.refs.get(note.id)?.length);

  const row = (note: ResearchNote) => (
    <li key={note.id} className={`research-row${note.done ? " is-done" : ""}`}>
      <input
        type="checkbox"
        className="research-chip-check"
        checked={note.done}
        title={t(note.done ? "research.reopen" : "research.markDone")}
        aria-label={t(note.done ? "research.reopen" : "research.markDone")}
        onChange={() => toggleDone(note)}
      />
      <button
        type="button"
        className="research-row-open"
        title={t(`research.kind.${note.kind}`)}
        onClick={() => { const existing = researchDraftOf(dataset, note.id); if (existing) setDraft(existing); }}
      >
        <span aria-hidden="true">{RESEARCH_ICON[note.kind]}</span>
        <span className="research-row-text">{researchTitle(note)}</span>
      </button>
      <span className="research-row-where">
        {(index.refs.get(note.id) ?? []).map((ref, i) => (
          <span key={i} className="research-row-ref">
            <PersonLink dataset={dataset} id={ref.recordId} fallback={whereLabel(ref)} onNavigate={onNavigate} />
            {ref.eventTag && <span className="research-chip-where">{eventDisplayLabel(ref.eventTag, t)}</span>}
          </span>
        ))}
      </span>
      {note.created && <span className="research-row-date gm-data">{displayDateText(note.created)}</span>}
    </li>
  );

  return (
    <div className="tools-research">
      <ToolsIntro>{t("tools.notebook.intro")}</ToolsIntro>
      <div className="tools-research-bar">
        <button type="button" className="nav-btn tools-run" onClick={() => setDraft({ fields: NEW_RESEARCH_FIELDS, targets: [] })}>
          + {t("tools.notebook.new")}
        </button>
        <Segmented
          label={t("tools.notebook.statusLabel")}
          value={status}
          onChange={setStatus}
          items={STATUSES.map((key) => ({ key, label: t(`tools.notebook.status.${key}`) }))}
        />
        <TreeSearch value={query} onChange={setQuery} />
      </div>
      {index.notes.length === 0 ? (
        <p className="tools-research-empty">{t("tools.notebook.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="tools-research-empty">{t("tools.notebook.noMatch")}</p>
      ) : (
        <>
          {unfiled.length > 0 && (
            <section className="tools-research-group">
              <h3 className="tools-research-heading">{t("tools.notebook.unfiled")} <span className="gm-data">{unfiled.length}</span></h3>
              <ul className="research-rows">{unfiled.map(row)}</ul>
            </section>
          )}
          {filed.length > 0 && (
            <section className="tools-research-group">
              <h3 className="tools-research-heading">{t("tools.notebook.filed")} <span className="gm-data">{filed.length}</span></h3>
              <ul className="research-rows">{filed.map(row)}</ul>
            </section>
          )}
        </>
      )}
      {draft && (
        <ResearchDialog
          key={draft.id ?? "new"}
          draft={draft}
          dataset={dataset}
          t={t}
          onClose={() => setDraft(null)}
          onSave={(fields, targets, newMedia) => { setDraft(null); apply(draft.id, fields, targets, newMedia); }}
          onRemove={draft.id ? () => { setDraft(null); apply(draft.id, null, []); } : undefined}
          onNavigate={(personId) => { setDraft(null); onNavigate(personId); }}
        />
      )}
    </div>
  );
}
