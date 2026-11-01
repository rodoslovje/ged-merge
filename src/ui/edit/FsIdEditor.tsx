import { useState } from "react";
import { FsIdLink } from "../FieldValue";
import type { ExternalId, Individual } from "../../gedcom/types";
import { exidTypeLabel } from "../../gedcom/exid";
import type { Translate } from "../../locales/i18n";
import { setFsIds, type FsIdTag } from "../../gedcom/edit";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth } from "./editConstants";
import { MergeChip, type MergeChipActions } from "./MergeChip";

/** The person's FamilySearch ids (`_FID`/`_FSFTID`) as chips: each links out to
 * the FamilySearch tree page and turns into an editable field on click. Renders
 * nothing without ids unless `addOnMount` opens an empty input (the "+
 * FamilySearch ID" chip's flow, like notes/media). */
export function FsIdEditor({
  person,
  preferredTag,
  addOnMount,
  t,
  commit,
  onEmptied,
  merge,
}: {
  person: Individual;
  /** Tag for a newly added id — the file's existing dialect (see `preferredFsIdTag`). */
  preferredTag: FsIdTag;
  addOnMount: boolean;
  t: Translate;
  commit: Commit;
  /** Called when an add is abandoned with nothing to show, so the host can
   * bring the "+ FamilySearch ID" chip back. */
  onEmptied?: () => void;
  /** Ids a confirmed match will add; `replacesFirst` — the first takes the
   *  place of the person's first id (see `personMergePreview`). */
  merge?: { ids: string[]; replacesFirst: boolean } & MergeChipActions;
}) {
  const ids = person.fsids ?? [];
  const [editing, setEditing] = useState<number | null>(addOnMount && !ids.length ? 0 : null);
  const [value, setValue] = useState("");

  if (!ids.length && editing === null && !merge) return null;

  function commitEdit(index: number) {
    const next = [...ids];
    next[index] = value.trim().toUpperCase();
    const cleaned = next.filter(Boolean);
    setEditing(null);
    // No-op edits (unchanged value, or abandoned empty input) skip the commit
    // so they don't create an undo step.
    if (cleaned.join("\x1f") !== ids.join("\x1f")) commit((indi) => setFsIds(indi, cleaned, preferredTag));
    else if (!cleaned.length) onEmptied?.();
  }

  function removeAt(index: number) {
    setEditing(null);
    // The not-yet-committed input of a fresh add: nothing to remove.
    if (index >= ids.length) { onEmptied?.(); return; }
    commit((indi) => setFsIds(indi, ids.filter((_, i) => i !== index), preferredTag));
  }

  return (
    <div className="edit-other-names">
      <div className="edit-other-names-row">
        {(editing !== null && editing >= ids.length ? [...ids, ""] : ids).map((id, i) =>
          editing === i ? (
            <span key={i} className="edit-name-chip edit-name-chip-editing">
              <ClearableInput
                className="edit-input edit-name-variant-input"
                wrapStyle={{ width: fieldWidth(value, "GPZG-CXL") }}
                value={value}
                placeholder="GPZG-CXL"
                title={t("edit.fsId")}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => commitEdit(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  // Abandon the edit; restoring the original value keeps any
                  // stray blur-commit a no-op.
                  if (e.key === "Escape") {
                    setValue(id);
                    setEditing(null);
                    if (!ids.length) onEmptied?.();
                  }
                }}
                onClear={() => setValue("")}
              />
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.removeFsId")}
                // Mousedown (with the default prevented) so the removal runs
                // before the input's blur-commit can close the editor under it.
                onMouseDown={(e) => { e.preventDefault(); removeAt(i); }}
              >
                ×
              </button>
            </span>
          ) : (
            <span key={i} className="edit-name-chip-wrap">
              <FsIdLink id={id} className="link-icon edit-link-icon" />
              <button
                type="button"
                className={`edit-name-chip${merge?.replacesFirst && i === 0 ? " edit-name-chip--replaced" : ""}`}
                title={merge?.replacesFirst && i === 0 ? t("edit.mergeReplacedTooltip") : t("edit.fsIdTooltip")}
                onClick={() => { setValue(id); setEditing(i); }}
              >
                {id}
                <span className="muted"> (FamilySearch)</span>
              </button>
            </span>
          ),
        )}
        {merge?.ids.map((id) => (
          <MergeChip key={`merge-${id}`} t={t} onTake={merge.onTake} onSkip={merge.onSkip}>
            {id}
            <span className="muted"> (FamilySearch)</span>
          </MergeChip>
        ))}
      </div>
    </div>
  );
}

/**
 * The person's other GEDCOM 7 external identifiers (`EXID` + `TYPE`, see
 * `gedcom/exid`), beside the FamilySearch ones: each id with the system that
 * gave it. A type URI ending in a slash is the base of that system's record
 * pages (as FamilySearch's own is), so the id opens there.
 */
export function ExternalIdChips({ exids, t, merge }: {
  exids: ExternalId[];
  t: Translate;
  /** Ids a confirmed match will add beside these. */
  merge?: { exids: ExternalId[] } & MergeChipActions;
}) {
  if (!exids.length && !merge?.exids.length) return null;
  return (
    <div className="edit-other-names">
      <div className="edit-other-names-row">
        {exids.map((x, i) => {
          const system = exidTypeLabel(x.type) ?? t("edit.exidUntyped");
          const href = x.type && /^https?:\/\/.+\/$/i.test(x.type) ? x.type + encodeURIComponent(x.id) : undefined;
          return (
            <span key={i} className="edit-name-chip-wrap">
              <span className="edit-name-chip edit-exid-chip" title={t("edit.exidTooltip", { type: x.type ?? system })}>
                {href ? <a href={href} target="_blank" rel="noopener noreferrer">{x.id}</a> : x.id}
                <span className="muted"> ({system})</span>
              </span>
            </span>
          );
        })}
        {merge?.exids.map((x, i) => (
          <MergeChip key={`merge-${i}`} t={t} onTake={merge.onTake} onSkip={merge.onSkip}>
            {x.id}
            <span className="muted"> ({exidTypeLabel(x.type) ?? t("edit.exidUntyped")})</span>
          </MergeChip>
        ))}
      </div>
    </div>
  );
}
