import type { GedcomVersion, Individual, Sex } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setSex } from "../../gedcom/edit";
import { sexClass } from "../sex";
import type { Commit } from "./types";
import { SEX_OPTIONS, SEX_GLYPHS } from "./editConstants";
import { DropdownMenu } from "../DropdownMenu";
import { altShiftLabel } from "../../keyboard/shortcuts";

/** Sex picker. Lives at the start of the "+ Add …" actions row. `merge` is the
 *  sex a confirmed match will write, shown in its place in the incoming color;
 *  picking one decides it (`onDecide` resolves the merge row). */
export function SexToggle({ person, t, commit, version, merge, onDecide }: {
  person: Individual;
  t: Translate;
  commit: Commit;
  version: GedcomVersion;
  merge?: Sex;
  onDecide?: () => void;
}) {
  const sex = merge ?? person.sex;
  return (
    <DropdownMenu
      className={`sex-select ${sexClass(sex)}${merge ? " edit-name-chip--merge" : ""}`}
      title={merge ? t("edit.mergeSexTooltip") : t("edit.sexTooltip", { key: altShiftLabel("X") })}
      current={sex}
      groups={[
        {
          items: SEX_OPTIONS.map((s) => ({
            value: s,
            label: `${SEX_GLYPHS[s]} ${t(`sex.${s}`)}`,
          })),
        },
      ]}
      onSelect={(v) => {
        commit((indi) => setSex(indi, v as Sex, version));
        if (merge) onDecide?.();
      }}
      trigger={
        <>
          {SEX_GLYPHS[sex]} {t(`sex.${sex}`)}
          <span className="sex-select-caret" aria-hidden="true">▾</span>
        </>
      }
    />
  );
}
