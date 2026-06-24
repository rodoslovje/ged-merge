import { useState } from "react";
import type { Translate } from "../../locales/i18n";

/** Dropdown chip that adds an event tag from a list of available tags.
 * Resets to the placeholder after selection. */
export function AddEventSelect({
  tags,
  groups,
  label,
  tooltip,
  t,
  onAdd,
  className = "add-chip add-chip-select",
}: {
  tags?: string[];
  groups?: { labelKey: string; tags: string[] }[];
  label: string;
  tooltip?: string;
  t: Translate;
  onAdd: (tag: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const hasAny = tags?.length || groups?.some((g) => g.tags.length);
  if (!hasAny) return null;
  return (
    <label className={className} title={tooltip}>
      + {label}
      <select
        className="add-chip-select-inner"
        value={value}
        onChange={(e) => {
          const tag = e.target.value;
          setValue("");
          if (tag) onAdd(tag);
        }}
      >
        <option value="" />
        {groups
          ? groups.map((g) => (
              <optgroup key={g.labelKey} label={t(g.labelKey)}>
                {g.tags.map((tag) => (
                  <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
                ))}
              </optgroup>
            ))
          : tags?.map((tag) => (
              <option key={tag} value={tag}>{t(`event.${tag}`)}</option>
            ))}
      </select>
    </label>
  );
}
