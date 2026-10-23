import { useState } from "react";
import type { GedEvent } from "../../gedcom/types";
import type { EventFieldUpdate } from "../../gedcom/edit";
import type { Translate } from "../../locales/i18n";
import { ADDRESS_PART_TAGS, type AddressPartTag } from "../../gedcom/address";
import { ClearableInput } from "./ClearableInput";

/** The contact lines beside the address, by the `EventFieldUpdate` key that writes each. */
const CONTACT_KEYS = ["phone", "email", "fax"] as const;
type ContactKey = (typeof CONTACT_KEYS)[number];

type Key = AddressPartTag | ContactKey;

/** What each field holds now, read from the event. */
function valuesOf(ev: GedEvent | undefined): Record<Key, string> {
  const out = {} as Record<Key, string>;
  for (const tag of ADDRESS_PART_TAGS) out[tag] = ev?.addressParts?.[tag] ?? "";
  for (const key of CONTACT_KEYS) out[key] = ev?.[key] ?? "";
  return out;
}

/**
 * The address in its labelled lines — street lines, town, region, postcode,
 * country — and the contact lines beside it, opened from the address field.
 *
 * Each field commits on its own, and only when it changed: the panel writes
 * the lines the user filled in and nothing else, so a file that keeps its
 * addresses as one line keeps them so until someone opens this and types.
 * The ADDR's own line stays the address field's, above.
 *
 * The parent remounts it (by key) when the event's values change underneath —
 * a commit rebuilds the record, undo replaces it.
 */
export function AddressStructure({
  ev,
  label,
  t,
  commit,
}: {
  ev: GedEvent | undefined;
  /** The event's name, for the fields' tooltips. */
  label: string;
  t: Translate;
  commit: (update: Partial<EventFieldUpdate>) => void;
}) {
  const [initial] = useState(() => valuesOf(ev));
  const [values, setValues] = useState(initial);

  const send = (key: Key, value: string) => {
    if (value === initial[key]) return;
    if ((CONTACT_KEYS as readonly string[]).includes(key)) commit({ [key]: value });
    else commit({ addressParts: { [key as AddressPartTag]: value } });
  };

  const field = (key: Key) => {
    const name = t(`event.addrPart.${key}`);
    return (
      <label key={key} className="edit-addr-part">
        <span className="edit-event-extra-label">{name}</span>
        <ClearableInput
          className={"edit-input" + (values[key] !== initial[key] ? " edit-input--dirty" : "")}
          data-addr-part={key}
          value={values[key]}
          title={t("event.addrPartTitle", { part: name, event: label })}
          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          onBlur={() => send(key, values[key])}
          onClear={() => {
            setValues((v) => ({ ...v, [key]: "" }));
            send(key, "");
          }}
        />
      </label>
    );
  };

  return (
    <div className="edit-addr-structure" role="group" aria-label={t("event.addrParts")}>
      {ADDRESS_PART_TAGS.map(field)}
      {CONTACT_KEYS.map(field)}
    </div>
  );
}
