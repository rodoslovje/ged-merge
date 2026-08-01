import { useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setFsIds, type FsIdTag } from "../../gedcom/edit";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth } from "./editConstants";

/** The public FamilySearch tree page for a person id. */
export function familySearchPersonUrl(id: string): string {
  return `https://www.familysearch.org/tree/person/details/${encodeURIComponent(id)}`;
}

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
}) {
  const ids = person.fsids ?? [];
  const [editing, setEditing] = useState<number | null>(addOnMount && !ids.length ? 0 : null);
  const [value, setValue] = useState("");

  if (!ids.length && editing === null) return null;

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
            </span>
          ) : (
            <span key={i} className="edit-name-chip-wrap">
              <a
                className="link-icon edit-link-icon"
                href={familySearchPersonUrl(id)}
                target="_blank"
                rel="noopener noreferrer"
                title={t("edit.fsIdOpen")}
              >
                🌳
              </a>
              <button
                type="button"
                className="edit-name-chip"
                title={t("edit.fsIdTooltip")}
                onClick={() => { setValue(id); setEditing(i); }}
              >
                {id}
                <span className="muted"> (FamilySearch)</span>
              </button>
              <button
                type="button"
                className="edit-link-remove"
                title={t("edit.removeFsId")}
                onClick={() => removeAt(i)}
              >
                ×
              </button>
            </span>
          ),
        )}
      </div>
    </div>
  );
}
