import { useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setMarriedName } from "../../gedcom/edit";
import { primaryName } from "../../match/relatives";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth } from "./editConstants";

/** Inline-editable married surname carried on the primary name's `_MARNM`
 * sub-tag — shown when the main file follows the `_MARNM` convention. */
export function MarriedNameEditor({
  person,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const [value, setValue] = useState(primaryName(person)?.married ?? "");

  return (
    <span className="edit-name-chip edit-name-chip-editing">
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(value, t("nametype.married")) }}
        value={value}
        placeholder={t("nametype.married")}
        title={t("nametype.married")}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit((indi) => setMarriedName(indi, value))}
        onClear={() => { setValue(""); commit((indi) => setMarriedName(indi, "")); }}
      />
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => setMarriedName(indi, ""));
          setValue("");
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}
