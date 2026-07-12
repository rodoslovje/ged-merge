import type { Individual, Sex } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setSex } from "../../gedcom/edit";
import { sexClass } from "../sex";
import type { Commit } from "./types";
import { SEX_OPTIONS, SEX_GLYPHS } from "./editConstants";
import { openPickerOnEnter } from "./openPicker";

/** Sex picker. Lives at the start of the "+ Add …" actions row. */
export function SexToggle({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  return (
    <select
      className={`sex-select ${sexClass(person.sex)}`}
      value={person.sex}
      onKeyDown={openPickerOnEnter}
      onChange={(e) => commit((indi) => setSex(indi, e.target.value as Sex))}
    >
      {SEX_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {SEX_GLYPHS[s]} {t(`sex.${s}`)}
        </option>
      ))}
    </select>
  );
}
