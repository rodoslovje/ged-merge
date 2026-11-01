import type { ReactNode } from "react";
import type { Translate } from "../../locales/i18n";

/** What a previewed incoming value does when clicked (`onTake`: write it into
 *  the record now, to edit) or dismissed (`onSkip`: leave it out of the save). */
export interface MergeChipActions {
  onTake: () => void;
  onSkip: () => void;
}

/**
 * A value a confirmed merge will write, shown where it will land — in the
 * incoming color, the way an incoming name or event field is. A click takes it
 * into the record (from then on it is the record's own, editable like any
 * other); × leaves it out of the save.
 */
export function MergeChip({ children, className, t, onTake, onSkip }: MergeChipActions & {
  children: ReactNode;
  className?: string;
  t: Translate;
}) {
  return (
    <span className="edit-name-chip-wrap">
      <button
        type="button"
        className={`edit-name-chip edit-name-chip--merge${className ? ` ${className}` : ""}`}
        title={t("edit.mergeValueTooltip")}
        onClick={onTake}
      >
        {children}
      </button>
      <button type="button" className="edit-link-remove" title={t("edit.skipMergeValue")} onClick={onSkip}>
        ×
      </button>
    </span>
  );
}
