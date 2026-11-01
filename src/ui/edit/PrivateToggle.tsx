import type { Translate } from "../../locales/i18n";

/** Small 🔒 chip toggling a record's private flag (MacFamilyTree `PRIV`,
 *  MyHeritage `_PRIV Y`, standard `RESN privacy` — written in the file's own
 *  dialect). Sits with the other action chips; filled when on. `target` names
 *  the record kind (person / family / …) so the "mark as private" tooltip can
 *  say what it affects. `merge` shows it on, in the incoming color, when only
 *  a confirmed match will set it — a click then leaves the flag out. */
export function PrivateToggle({ on, t, onToggle, target, hint, merge }: {
  on: boolean;
  t: Translate;
  onToggle: () => void;
  target: string;
  /** The shortcut, where one flips this lock. */
  hint?: string;
  merge?: boolean;
}) {
  const shown = on || !!merge;
  const title = merge ? t("edit.mergePrivateTooltip") : on ? t("edit.privateOn") : t("edit.privateOff", { target });
  return (
    <button
      type="button"
      className={`edit-name-chip private-toggle${shown ? " is-on" : ""}${merge ? " edit-name-chip--merge" : ""}`}
      title={hint ? `${title} (${hint})` : title}
      aria-pressed={shown}
      onClick={onToggle}
    >
      🔒{shown ? ` ${t("edit.privateLabel")}` : ""}
    </button>
  );
}
