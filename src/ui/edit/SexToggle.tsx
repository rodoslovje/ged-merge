import type { Individual, Sex } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setSex } from "../../gedcom/edit";
import { sexClass } from "../sex";
import type { Commit } from "./types";
import { SEX_OPTIONS, SEX_GLYPHS } from "./editConstants";

export function SexToggle({ person, t, commit, onDelete, kinship, kinshipTooltip }: { person: Individual; t: Translate; commit: Commit; onDelete: () => void; kinship?: string; kinshipTooltip?: string }) {
  return (
    <div className="edit-sex-row">
      {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
      <select
        className={`sex-select ${sexClass(person.sex)}`}
        value={person.sex}
        onChange={(e) => commit((indi) => setSex(indi, e.target.value as Sex))}
      >
        {SEX_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {SEX_GLYPHS[s]} {t(`sex.${s}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-delete-btn"
        title={t("edit.deletePersonTooltip")}
        onClick={onDelete}
      >
        🗑
      </button>
    </div>
  );
}
