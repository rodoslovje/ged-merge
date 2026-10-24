import { useRef, useState } from "react";
import type { GedcomVersion, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { setAdditionalName, removeAdditionalName, foldAdditionalNameToMarnm } from "../../gedcom/edit";
import { additionalNameTypes, nameTypeLabel } from "../../match/relatives";
import { ClearableInput } from "./ClearableInput";
import { SelectMenu } from "../DropdownMenu";
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
  version,
  onDone,
}: {
  person: Individual;
  index: number;
  t: Translate;
  commit: Commit;
  /** When set, choosing the "married" type stores the surname inline as the
   * primary name's `_MARNM` (the main's convention) rather than keeping a
   * separate `TYPE married` record. */
  marriedNameTag?: boolean;
  /** The file's GEDCOM version, which spells the `TYPE` (see `spellNameType`). */
  version?: GedcomVersion;
  onDone: () => void;
}) {
  const name = person.names[index + 1];
  const [given, setGiven] = useState(name?.given ?? "");
  const [surname, setSurname] = useState(name?.surname ?? "");
  // The menu's options are lower case; a 7.0 file writes the same types upper
  // case. A type the standard does not define stays listed for this name only,
  // so the menu shows what the file says until another type is picked.
  const offered = additionalNameTypes(version);
  const typeOption = offered.find((opt) => opt === name?.type?.toLowerCase()) ?? name?.type ?? "aka";
  const typeOptions = offered.includes(typeOption) ? offered : [...offered, typeOption];

  function commitFields(nextGiven: string, nextSurname: string) {
    // Only a real change may write: setAdditionalName canonicalizes the NAME
    // line's slash form, so an unguarded blur would rewrite the user's own
    // formatting on a mere click-in/click-out (same guard as NameEditor).
    const current = person.names[index + 1];
    if (nextGiven === (current?.given ?? "") && nextSurname === (current?.surname ?? "")) return;
    commit((indi) => setAdditionalName(indi, index, { given: nextGiven, surname: nextSurname }, version));
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
      <SelectMenu
        className="edit-input edit-name-type-select"
        value={typeOption}
        title={t("field.nameType")}
        onChange={(next) => {
          // Main stores married surnames inline as `_MARNM`: fold this record
          // into it instead of keeping a separate `TYPE married` NAME record.
          if (next === "married" && marriedNameTag) {
            commit((indi) => foldAdditionalNameToMarnm(indi, index));
            onDone();
          } else {
            commit((indi) => setAdditionalName(indi, index, { type: next }, version));
          }
        }}
        options={typeOptions.map((opt) => ({
          value: opt,
          label: nameTypeLabel(opt, t, opt === typeOption ? name?.typePhrase : undefined),
        }))}
      />
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
