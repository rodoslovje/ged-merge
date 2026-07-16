import type { Translate } from "../../locales/i18n";

/** Small 🔒 chip toggling a record's private flag (MacFamilyTree `PRIV`,
 *  MyHeritage `_PRIV Y`, standard `RESN privacy` — written in the file's own
 *  dialect). Sits with the other action chips; filled when on. */
export function PrivateToggle({ on, t, onToggle }: { on: boolean; t: Translate; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`edit-name-chip private-toggle${on ? " is-on" : ""}`}
      title={t(on ? "edit.privateOn" : "edit.privateOff")}
      aria-pressed={on}
      onClick={onToggle}
    >
      🔒{on ? ` ${t("edit.privateLabel")}` : ""}
    </button>
  );
}
