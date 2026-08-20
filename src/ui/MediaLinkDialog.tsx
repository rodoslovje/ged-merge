import { useEffect, useRef, useState } from "react";
import type { Translate } from "../locales/i18n";
import { SourceDialogShell } from "./source/SourceDialogShell";
import { SourceLinkRow } from "./source/SourceLinkRow";

/**
 * The media-link chip's dialog: a stripped-down sibling of Edit Source for a
 * link that is an `OBJE`, not a `SOUR` — one editable URL field with the same
 * hover ↗ beside it, and the same Remove / Cancel / Save footer. Saving a
 * changed URL rewrites the media record's `FILE` (a shared-record edit, like
 * editing a source's fields); Remove deletes the link, undo-safe.
 */
export function MediaLinkDialog({
  url,
  t,
  onClose,
  onSave,
  onRemove,
}: {
  url: string;
  t: Translate;
  onClose: () => void;
  /** Commit the edited URL (never blank — Save disables on an empty field). */
  onSave: (newUrl: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus with the caret at the start: plain autofocus parks it at the end,
  // scrolling a long URL so only its tail is visible.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, 0);
    el.scrollLeft = 0;
  }, []);
  const trimmed = value.trim();
  return (
    <SourceDialogShell
      icon="🔗"
      title={t("mediaLink.title")}
      t={t}
      onClose={onClose}
      className="media-link-dialog"
      actions={
        <>
          <button className="tree-open-btn add-source-remove" onClick={onRemove}>{t("editSource.remove")}</button>
          <button className="tree-open-btn" onClick={onClose}>{t("addSource.cancel")}</button>
          <button
            className="add-source-submit"
            disabled={!trimmed}
            onClick={() => (trimmed === url ? onClose() : onSave(trimmed))}
          >
            {t("editSource.save")}
          </button>
        </>
      }
    >
      <SourceLinkRow
        label={t("addSource.field.url")}
        value={value}
        onChange={setValue}
        t={t}
        inputRef={inputRef}
      />
    </SourceDialogShell>
  );
}
