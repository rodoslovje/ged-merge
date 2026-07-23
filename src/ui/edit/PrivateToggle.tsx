import type { Translate } from "../../locales/i18n";

/** Small 🔒 chip toggling a record's private flag (MacFamilyTree `PRIV`,
 *  MyHeritage `_PRIV Y`, standard `RESN privacy` — written in the file's own
 *  dialect). Sits with the other action chips; filled when on. `target` names
 *  the record kind (person / family / …) so the "mark as private" tooltip can
 *  say what it affects. */
export function PrivateToggle({ on, t, onToggle, target }: { on: boolean; t: Translate; onToggle: () => void; target: string }) {
  return (
    <button
      type="button"
      className={`edit-name-chip private-toggle${on ? " is-on" : ""}`}
      title={on ? t("edit.privateOn") : t("edit.privateOff", { target })}
      aria-pressed={on}
      onClick={onToggle}
    >
      🔒{on ? ` ${t("edit.privateLabel")}` : ""}
    </button>
  );
}
