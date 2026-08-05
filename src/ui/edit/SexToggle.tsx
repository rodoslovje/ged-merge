import type { Individual, Sex } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setSex } from "../../gedcom/edit";
import { sexClass } from "../sex";
import type { Commit } from "./types";
import { SEX_OPTIONS, SEX_GLYPHS } from "./editConstants";
import { DropdownMenu } from "../DropdownMenu";

/** Sex picker. Lives at the start of the "+ Add …" actions row. */
export function SexToggle({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  return (
    <DropdownMenu
      className={`sex-select ${sexClass(person.sex)}`}
      current={person.sex}
      groups={[
        {
          items: SEX_OPTIONS.map((s) => ({
            value: s,
            label: `${SEX_GLYPHS[s]} ${t(`sex.${s}`)}`,
          })),
        },
      ]}
      onSelect={(v) => commit((indi) => setSex(indi, v as Sex))}
      trigger={
        <>
          {SEX_GLYPHS[person.sex]} {t(`sex.${person.sex}`)}
          <span className="sex-select-caret" aria-hidden="true">▾</span>
        </>
      }
    />
  );
}
