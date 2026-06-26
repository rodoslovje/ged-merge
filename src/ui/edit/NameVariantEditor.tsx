import { useRef, useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setAdditionalName, removeAdditionalName, foldAdditionalNameToMarnm } from "../../gedcom/edit";
import { ADDITIONAL_NAME_TYPES, nameTypeLabel } from "../../match/relatives";
import { ClearableInput } from "./ClearableInput";
import type { Commit } from "./types";
import { fieldWidth } from "./editConstants";

/** Inline-editable given/surname/type for an additional `NAME` record
 * (married/maiden/aka/…) — see `setAdditionalName` for indexing. */
export function NameVariantEditor({
  person,
  index,
  t,
  commit,
  marriedNameTag,
  onDone,
}: {
  person: Individual;
  index: number;
  t: Translate;
  commit: Commit;
  /** When set, choosing the "married" type stores the surname inline as the
   * primary name's `_MARNM` (the master's convention) rather than keeping a
   * separate `TYPE married` record. */
  marriedNameTag?: boolean;
  onDone: () => void;
}) {
  const name = person.names[index + 1];
  const [given, setGiven] = useState(name?.given ?? "");
  const [surname, setSurname] = useState(name?.surname ?? "");

  function commitFields(nextGiven: string, nextSurname: string) {
    commit((indi) => setAdditionalName(indi, index, { given: nextGiven, surname: nextSurname }));
  }

  const ref = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={ref}
      className="edit-name-chip edit-name-chip-editing"
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) onDone(); }}
    >
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(given, t("field.given"), 12) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        autoFocus
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setGiven(""); commitFields("", surname); }}
      />
      <ClearableInput
        className="edit-input edit-name-variant-input"
        wrapStyle={{ width: fieldWidth(surname, t("field.surname"), 12) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitFields(given, surname)}
        onClear={() => { setSurname(""); commitFields(given, ""); }}
      />
      <select
        className="edit-input edit-name-type-select"
        value={name?.type ?? "aka"}
        title={t("field.nameType")}
        onChange={(e) => {
          const next = e.target.value;
          // Master stores married surnames inline as `_MARNM`: fold this record
          // into it instead of keeping a separate `TYPE married` NAME record.
          if (next === "married" && marriedNameTag) {
            commit((indi) => foldAdditionalNameToMarnm(indi, index));
            onDone();
          } else {
            commit((indi) => setAdditionalName(indi, index, { type: next }));
          }
        }}
      >
        {ADDITIONAL_NAME_TYPES.map((opt) => (
          <option key={opt} value={opt}>
            {nameTypeLabel(opt, t)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => removeAdditionalName(indi, index));
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}
